import { Router } from 'express';
import { z } from 'zod';
import {
  Referrer, Referral, ReferralActivity, Job, JobApplication, EGAApplication, NewsletterSubscriber,
} from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, oid, isObjectId } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import {
  REFERRAL_STAGES, REFERRER_TIERS, EMPLOYMENT_TYPES, JOB_STATUSES, APPLICATION_STATUSES, EGA_STATUSES,
} from '../../../shared/constants/os.js';
import {
  createUniqueReferralCode, updateReferralStage, markRewardPaid, promoteReferralToLead,
} from '../services/referral.service.js';

// ---------------------------------------------------------------- referrers
export const referrerRoutes = crudRouter({
  model: Referrer,
  resource: 'growth',
  entityType: 'referrer',
  label: 'Referrer',
  searchFields: ['fullName', 'email', 'phone', 'referralCode'],
  filterFields: ['tier', 'isPublicPartner'],
  createSchema: z.object({
    fullName: z.string().min(1, 'Name is required'),
    email: z.string().email('Valid email required'),
    phone: z.string().optional(),
    isPublicPartner: z.boolean().optional(),
  }),
  updateSchema: z.object({
    fullName: z.string().min(1).optional(),
    phone: z.string().optional(),
    tier: z.enum(REFERRER_TIERS).optional(),
    isPublicPartner: z.boolean().optional(),
  }),
  hasRecordStatus: true,
  prepare: async (data, ctx, existing) => {
    if (!existing) data.referralCode = await createUniqueReferralCode(ctx.organizationId, String(data.fullName), String(data.phone || ''));
    return data;
  },
  extend: (router) => {
    router.get(
      '/:id/overview',
      authorize('growth:read'),
      route(async (req) => {
        if (!isObjectId(req.params.id)) throw new NotFoundError('Referrer');
        const referrer = await Referrer.findOne({ _id: req.params.id, organizationId: req.user!.organizationId }).lean();
        if (!referrer) throw new NotFoundError('Referrer');
        const referrals = await Referral.find({ referrerId: referrer._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean();
        return { referrer, referrals };
      })
    );
  },
});

// ---------------------------------------------------------------- referrals
export const referralRoutes = crudRouter({
  model: Referral,
  resource: 'growth',
  entityType: 'referral',
  label: 'Referral',
  titleOf: (d) => d.referredName,
  searchFields: ['referredName', 'referredBusiness', 'referredEmail', 'referredPhone'],
  filterFields: ['stage', 'rewardStatus', 'referrerId', 'flaggedDuplicate'],
  populate: { path: 'referrerId', select: 'fullName email referralCode tier' },
  createSchema: z.object({
    referrerId: z.string().min(1, 'Select a referrer'),
    referredName: z.string().min(1, 'Name is required'),
    referredBusiness: z.string().optional(),
    referredEmail: z.string().optional(),
    referredPhone: z.string().optional(),
    referredNeeds: z.string().optional(),
    referrerNotes: z.string().optional(),
  }),
  updateSchema: z.object({
    referredName: z.string().min(1).optional(),
    referredBusiness: z.string().optional(),
    referredEmail: z.string().optional(),
    referredPhone: z.string().optional(),
    referredNeeds: z.string().optional(),
    adminInternalNotes: z.string().optional(),
  }),
  prepare: async (data, ctx, existing) => {
    if (existing) return data;
    const referrer = isObjectId(data.referrerId) ? await Referrer.exists({ _id: data.referrerId, organizationId: ctx.organizationId }) : null;
    if (!referrer) throw new ValidationError('Referrer not found');
    const dup = await Referral.exists({
      organizationId: ctx.organizationId,
      $or: [data.referredEmail ? { referredEmail: String(data.referredEmail).toLowerCase() } : null, data.referredPhone ? { referredPhone: data.referredPhone } : null].filter(Boolean) as object[],
    });
    if (dup && (data.referredEmail || data.referredPhone)) data.flaggedDuplicate = true;
    return data;
  },
  afterCreate: async (doc, ctx) => {
    await ReferralActivity.create({ organizationId: ctx.organizationId, referralId: doc._id, eventType: 'created', toStage: 'submitted', createdBy: ctx.actor.email });
  },
  extend: (router) => {
    router.get(
      '/rewards/queue',
      authorize('growth:read'),
      route(async (req) => {
        const rows = await Referral.find({ organizationId: req.user!.organizationId, rewardStatus: { $in: ['pending', 'paid'] }, recordStatus: 'active' })
          .populate('referrerId', 'fullName email phone referralCode tier')
          .sort({ rewardStatus: 1, convertedAt: -1 })
          .lean();
        const pending = rows.filter((r) => r.rewardStatus === 'pending');
        return { rows, totals: { pending: pending.reduce((s, r) => s + r.rewardAmount, 0), paid: rows.filter((r) => r.rewardStatus === 'paid').reduce((s, r) => s + r.rewardAmount, 0), pendingCount: pending.length } };
      })
    );

    router.get(
      '/:id/activity',
      authorize('growth:read'),
      route(async (req) => ReferralActivity.find({ organizationId: req.user!.organizationId, referralId: req.params.id }).sort({ createdAt: -1 }).lean())
    );

    router.post(
      '/:id/stage',
      authorize('growth:write'),
      route(async (req) => {
        const body = z.object({
          stage: z.enum(REFERRAL_STAGES), projectType: z.string().optional(), projectValue: z.coerce.number().optional(),
          lostReason: z.string().optional(), note: z.string().optional(),
        }).parse(req.body);
        return updateReferralStage(actorFrom(req.user!), req.params.id as string, body);
      })
    );

    router.post('/:id/reward-paid', authorize('growth:write'), route(async (req) => markRewardPaid(actorFrom(req.user!), req.params.id as string)));
    router.post('/:id/promote', authorize('leads:write'), route(async (req) => promoteReferralToLead(actorFrom(req.user!), req.params.id as string)));
  },
});

// ---------------------------------------------------------------- careers
const formFieldSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

const jobSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  slug: z.string().optional(),
  department: z.string().optional(),
  location: z.string().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  requirements: z.string().optional(),
  benefits: z.string().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  formFields: z.array(formFieldSchema).optional(),
});

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const jobRoutes = crudRouter({
  model: Job,
  resource: 'growth',
  entityType: 'job',
  label: 'Job',
  searchFields: ['title', 'department', 'location'],
  filterFields: ['status', 'employmentType'],
  createSchema: jobSchema,
  updateSchema: jobSchema.partial(),
  prepare: async (data, ctx, existing) => {
    if (!existing) {
      const base = slugify(String(data.slug || data.title)) || 'job';
      let slug = base;
      for (let i = 2; await Job.exists({ organizationId: ctx.organizationId, slug }); i++) slug = `${base}-${i}`;
      data.slug = slug;
    } else {
      delete data.slug;
    }
    if (data.status === 'published' && existing?.status !== 'published') data.publishedAt = new Date();
    return data;
  },
  extend: (router) => {
    router.get(
      '/:id/applications',
      authorize('growth:read'),
      route(async (req) => JobApplication.find({ organizationId: req.user!.organizationId, jobId: req.params.id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean())
    );
  },
});

export const jobApplicationRoutes = crudRouter({
  model: JobApplication,
  resource: 'growth',
  entityType: 'job_application',
  label: 'Application',
  titleOf: (d) => d.applicantName,
  searchFields: ['applicantName', 'applicantEmail', 'jobTitle'],
  filterFields: ['status', 'jobId'],
  updateSchema: z.object({ status: z.enum(APPLICATION_STATUSES).optional(), adminNotes: z.string().optional() }),
  createSchema: z.object({}).refine(() => false, 'Applications are submitted from the careers page'),
});

// ---------------------------------------------------------------- EGA
export const egaRoutes = crudRouter({
  model: EGAApplication,
  resource: 'growth',
  entityType: 'ega_application',
  label: 'EGA application',
  titleOf: (d) => d.fullName,
  searchFields: ['fullName', 'email', 'college', 'city'],
  filterFields: ['status'],
  defaultSort: { score: -1, createdAt: -1 },
  updateSchema: z.object({ status: z.enum([...EGA_STATUSES, 'shortlisted'] as [string, ...string[]]).optional(), adminNotes: z.string().optional() }),
  createSchema: z.object({}).refine(() => false, 'EGA applications are submitted from the public form'),
  afterUpdate: async (doc, prev, ctx) => {
    if (doc.status !== prev.status) await logActivity(ctx.actor, { title: `EGA status → ${doc.status}`, detail: doc.fullName, entityType: 'ega_application', entityId: String(doc._id) });
  },
});

// ---------------------------------------------------------------- newsletter
export const newsletterRoutes = Router();
newsletterRoutes.use(authenticate);

newsletterRoutes.get(
  '/',
  authorize('growth:read'),
  route(async (req) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { organizationId: oid(req.user!.organizationId), recordStatus: 'active' };
    if (q.status) filter.status = q.status;
    const rows = await NewsletterSubscriber.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
    return { rows, total: rows.length, subscribed: rows.filter((r) => r.status === 'subscribed').length };
  })
);

newsletterRoutes.patch(
  '/:id',
  authorize('growth:write'),
  route(async (req) => {
    const status = req.body?.status === 'unsubscribed' ? 'unsubscribed' : 'subscribed';
    const row = await NewsletterSubscriber.findOneAndUpdate({ _id: req.params.id, organizationId: req.user!.organizationId }, { $set: { status } }, { new: true }).lean();
    if (!row) throw new NotFoundError('Subscriber');
    return row;
  })
);
