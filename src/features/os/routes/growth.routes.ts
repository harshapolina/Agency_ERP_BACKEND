import { Router } from 'express';
import { z } from 'zod';
import {
  Referrer, Referral, ReferralActivity, Job, JobApplication, EGAApplication, EGAFormConfig,
  NewsletterSubscriber, NewsletterTemplate, NewsletterCampaign, MagazineIssue, MagazineArticle,
} from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, oid, isObjectId, parseBody } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import {
  REFERRAL_STAGES, REFERRER_TIERS, EMPLOYMENT_TYPES, JOB_STATUSES, APPLICATION_STATUSES, EGA_STATUSES,
} from '../../../shared/constants/os.js';
import {
  createUniqueReferralCode, updateReferralStage, markRewardPaid, promoteReferralToLead,
} from '../services/referral.service.js';
import { DEFAULT_EGA_FORM, scoreEgaAnswers, type EgaFormField } from '../../../shared/constants/ega-form.js';
import { isMailConfigured, sendMail } from '../../../shared/utils/mailer.js';
import { env } from '../../../config/env.js';
import { Organization } from '../../../models/Organization.js';

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
  extend: (router) => {
    router.get('/form', authorize('growth:read'), route(async (req) => ensureEgaForm(req.user!.organizationId, req.user!.email)));
    router.put(
      '/form',
      authorize('growth:write'),
      route(async (req) => {
        const body = parseBody<{ title?: string; subtitle?: string; published?: boolean; fields?: EgaFormField[] }>(
          z.object({
            title: z.string().min(2).optional(),
            subtitle: z.string().optional(),
            published: z.boolean().optional(),
            fields: z.array(z.object({
              id: z.string().min(1),
              type: z.enum(['text', 'email', 'select', 'multiselect', 'scale', 'textarea']),
              label: z.string().min(1),
              section: z.string().optional(),
              placeholder: z.string().optional(),
              helpText: z.string().optional(),
              required: z.boolean().optional(),
              options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
              scoreMap: z.record(z.number()).optional(),
              maxScore: z.number().optional(),
            })).min(1).optional(),
          }),
          req.body
        );
        const current = await ensureEgaForm(req.user!.organizationId, req.user!.email);
        Object.assign(current, body, { updatedBy: req.user!.email });
        await current.save();
        return current.toObject();
      })
    );
  },
});

export async function ensureEgaForm(organizationId: string, email = 'system') {
  let doc = await EGAFormConfig.findOne({ organizationId, recordStatus: 'active' });
  if (!doc) {
    doc = await EGAFormConfig.create({
      organizationId, ...DEFAULT_EGA_FORM, createdBy: email, updatedBy: email,
    });
  }
  return doc;
}

async function uniqueSlug(model: { exists: (q: object) => Promise<unknown> }, organizationId: string, base: string) {
  const root = base || 'item';
  let slug = root;
  for (let i = 2; await model.exists({ organizationId, slug }); i++) slug = `${root}-${i}`;
  return slug;
}

export const magazineIssueRoutes = crudRouter({
  model: MagazineIssue,
  resource: 'growth',
  entityType: 'magazine_issue',
  label: 'Issue',
  searchFields: ['title', 'summary'],
  filterFields: ['status'],
  createSchema: z.object({ title: z.string().min(2), summary: z.string().optional(), cover: z.string().optional(), status: z.enum(['draft', 'published']).optional() }),
  updateSchema: z.object({ title: z.string().min(2).optional(), summary: z.string().optional(), cover: z.string().optional(), status: z.enum(['draft', 'published']).optional() }),
  prepare: async (data, ctx, existing) => {
    if (!existing) data.slug = await uniqueSlug(MagazineIssue, ctx.organizationId, slugify(String(data.title)));
    if (data.status === 'published' && existing?.status !== 'published') data.publishedAt = new Date();
    return data;
  },
});

export const magazineArticleRoutes = crudRouter({
  model: MagazineArticle,
  resource: 'growth',
  entityType: 'magazine_article',
  label: 'Article',
  searchFields: ['title', 'excerpt', 'tags'],
  filterFields: ['status', 'issueId'],
  createSchema: z.object({
    title: z.string().min(2), excerpt: z.string().optional(), body: z.string().min(1, 'Article body is required'),
    cover: z.string().optional(), tags: z.array(z.string()).optional(), issueId: z.string().optional(),
    status: z.enum(['draft', 'published']).optional(),
  }),
  updateSchema: z.object({
    title: z.string().min(2).optional(), excerpt: z.string().optional(), body: z.string().optional(),
    cover: z.string().optional(), tags: z.array(z.string()).optional(), issueId: z.string().optional().nullable(),
    status: z.enum(['draft', 'published']).optional(),
  }),
  prepare: async (data, ctx, existing) => {
    if (!existing) data.slug = await uniqueSlug(MagazineArticle, ctx.organizationId, slugify(String(data.title)));
    if (data.status === 'published' && existing?.status !== 'published') data.publishedAt = new Date();
    return data;
  },
});

export const newsletterTemplateRoutes = crudRouter({
  model: NewsletterTemplate,
  resource: 'growth',
  entityType: 'newsletter_template',
  label: 'Template',
  searchFields: ['name', 'subject'],
  createSchema: z.object({ name: z.string().min(2), subject: z.string().optional(), body: z.string().optional() }),
  updateSchema: z.object({ name: z.string().min(2).optional(), subject: z.string().optional(), body: z.string().optional() }),
});

export const newsletterCampaignRoutes = Router();
newsletterCampaignRoutes.use(authenticate);

newsletterCampaignRoutes.get('/', authorize('growth:read'), route(async (req) =>
  NewsletterCampaign.find({ organizationId: req.user!.organizationId, recordStatus: 'active' }).sort({ createdAt: -1 }).limit(100).lean()
));

newsletterCampaignRoutes.post('/', authorize('growth:write'), route(async (req, res) => {
  const b = parseBody<{ subject: string; body: string; articleId?: string }>(
    z.object({ subject: z.string().min(2), body: z.string().min(1), articleId: z.string().optional() }),
    req.body
  );
  const campaign = await NewsletterCampaign.create({
    organizationId: req.user!.organizationId, ...b, status: 'draft', createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  res.status(201);
  return campaign;
}));

newsletterCampaignRoutes.post('/:id/send', authorize('growth:write'), route(async (req) => {
  const campaign = await NewsletterCampaign.findOne({ _id: req.params.id, organizationId: req.user!.organizationId });
  if (!campaign) throw new NotFoundError('Campaign');
  const subscribers = await NewsletterSubscriber.find({ organizationId: req.user!.organizationId, status: 'subscribed', recordStatus: 'active' }).select('email').lean();
  const emails = subscribers.map((s) => s.email);
  campaign.recipientCount = emails.length;
  campaign.status = 'sending';
  await campaign.save();

  let magUrl = '';
  if (campaign.articleId) {
    const article = await MagazineArticle.findById(campaign.articleId).select('slug').lean();
    const org = await Organization.findById(req.user!.organizationId).select('slug').lean();
    if (article?.slug && org?.slug) magUrl = `${env.APP_URL.replace(/\/$/, '')}/magazine/${org.slug}/${article.slug}`;
  }
  const html = `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;color:#111;line-height:1.6">
    <div style="max-width:560px;margin:24px auto">${campaign.body.replace(/\n/g, '<br/>')}
    ${magUrl ? `<p><a href="${magUrl}">Read in our magazine →</a></p>` : ''}
    </div></body></html>`;

  if (!emails.length) {
    campaign.status = 'sent';
    campaign.sentAt = new Date();
    campaign.deliveredCount = 0;
    campaign.skippedSmtp = true;
    await campaign.save();
    return campaign;
  }

  if (!(await isMailConfigured(req.user!.organizationId))) {
    campaign.status = 'sent';
    campaign.sentAt = new Date();
    campaign.deliveredCount = 0;
    campaign.skippedSmtp = true;
    campaign.error = 'SMTP is not configured — campaign saved as sent locally so you can still track it.';
    await campaign.save();
    return campaign;
  }

  const ok = await sendMail(emails, campaign.subject, html, { organizationId: req.user!.organizationId });
  campaign.status = ok ? 'sent' : 'failed';
  campaign.sentAt = new Date();
  campaign.deliveredCount = ok ? emails.length : 0;
  campaign.error = ok ? '' : 'SMTP send failed';
  await campaign.save();
  return campaign;
}));

// ---------------------------------------------------------------- newsletter subscribers
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
