import { Router, type Request } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import {
  PortalAccess, Conversion, Vendor, Project, ProjectUpdate, Task, Invoice, Payment, OsDocument, Milestone, Meeting,
  Job, JobApplication, Referrer, Referral, ReferralActivity, EGAApplication, NewsletterSubscriber,
  MagazineIssue, MagazineArticle, PortalComment, PortalApproval, PortalTicket,
} from '../../../models/index.js';
import { Organization } from '../../../models/Organization.js';
import { runWithOrganization } from '../../../config/tenant.js';
import { route, parseBody, isObjectId } from '../../../shared/utils/crud.js';
import { notifyStaff } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { sha256Hex } from '../../../shared/utils/crypto.js';
import { withDisplayStatus, numberToWordsINR } from '../../../shared/os/money.js';
import { companyProfile, type CompanyRecord } from '../../../shared/os/company.js';
import { ACTIVE_PROJECT_STATUSES, normalizeProjectStatus } from '../../../shared/constants/os.js';
import { conversionRollup } from '../services/conversion.service.js';
import { createUniqueReferralCode, computeEGAScore } from '../services/referral.service.js';
import { ensureEgaForm } from './growth.routes.js';
import { scoreEgaAnswers, type EgaFormField } from '../../../shared/constants/ega-form.js';

export const publicRoutes = Router({ mergeParams: true });

publicRoutes.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

async function orgFrom(req: Request) {
  const org = await Organization.findOne({ slug: String(req.params.orgSlug || '').toLowerCase(), isActive: true }).select('_id name slug logo profile').lean();
  if (!org) throw new NotFoundError('Organization');
  return org;
}

/** Resolves the org from the URL slug and runs `fn` against that org's database. */
function inOrg<T>(fn: (req: Request, organizationId: string, org: { name: string; slug: string } & CompanyRecord) => Promise<T>) {
  return route(async (req) => {
    const org = await orgFrom(req);
    const organizationId = String(org._id);
    return runWithOrganization(organizationId, () => fn(req, organizationId, org));
  });
}

// ---------------------------------------------------------------- client portal
async function resolvePortal(organizationId: string, token: string) {
  const access = await PortalAccess.findOne({ organizationId, tokenHash: sha256Hex(token), isActive: true });
  if (!access) throw new NotFoundError('Portal');
  const [conversion, vendor] = await Promise.all([
    Conversion.findOne({ organizationId, conversionUuid: access.conversionUuid }).lean(),
    Vendor.findOne({ organizationId, conversionUuid: access.conversionUuid, recordStatus: 'active' }).lean(),
  ]);
  if (!conversion || !vendor) throw new NotFoundError('Portal');
  access.lastLoginAt = new Date();
  await access.save();
  return { conversion, vendor, conversionUuid: access.conversionUuid as string };
}

const clientInvoiceFilter = (organizationId: string, conversionUuid: string) => ({
  organizationId, conversionUuid, recordStatus: 'active', status: { $nin: ['draft', 'cancelled'] },
});

publicRoutes.get(
  '/portal/:token',
  inOrg(async (req, organizationId, org) => {
    const { conversion, vendor, conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
    const [rollup, projects, updates, actionTasks, invoices, documents, meetings, payments, comments, approvals, tickets] = await Promise.all([
      conversionRollup(organizationId, conversionUuid),
      Project.find({ organizationId, conversionUuid, recordStatus: { $ne: 'archived' } }).select('name service status progress startDate expectedDelivery').sort({ createdAt: -1 }).lean(),
      ProjectUpdate.find({ organizationId, conversionUuid, visibility: 'client_visible', recordStatus: 'active', publishedAt: { $exists: true } }).sort({ publishedAt: -1 }).limit(20).lean(),
      Task.find({ organizationId, conversionUuid, visibleToClient: true, recordStatus: { $ne: 'archived' }, status: { $nin: ['completed', 'cancelled'] } }).select('title description status dueDate clientActionRequired projectId').sort({ createdAt: -1 }).limit(20).lean(),
      Invoice.find(clientInvoiceFilter(organizationId, conversionUuid)).select('invoiceNumber issueDate dueDate total amountPaid status').sort({ issueDate: -1 }).lean(),
      OsDocument.find({ organizationId, conversionUuid, visibleToClient: true, recordStatus: 'active' }).select('title fileName mimeType size createdAt').sort({ createdAt: -1 }).lean(),
      Meeting.find({ organizationId, conversionUuid, visibleToClient: true, recordStatus: 'active' }).select('title startsAt meetingType decisions actionItems').sort({ startsAt: -1 }).limit(10).lean(),
      Payment.find({ organizationId, conversionUuid, recordStatus: 'active' }).select('amount paidAt method').sort({ paidAt: -1 }).lean(),
      PortalComment.find({ organizationId, conversionUuid }).sort({ createdAt: -1 }).limit(50).lean(),
      PortalApproval.find({ organizationId, conversionUuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
      PortalTicket.find({ organizationId, conversionUuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    ]);
    const milestones = await Milestone.find({ organizationId, projectId: { $in: projects.map((p) => p._id) }, visibleToClient: true, recordStatus: 'active' }).sort({ sortOrder: 1 }).lean();
    return {
      organization: { name: org.name, logo: org.logo || '' },
      client: { companyName: vendor.companyName, contactPerson: vendor.contactPerson, publicCode: conversion.publicCode },
      rollup,
      projects: projects.map((p) => ({ ...p, status: normalizeProjectStatus(p.status), milestones: milestones.filter((m) => String(m.projectId) === String(p._id)) })),
      updates,
      tasks: actionTasks,
      invoices: invoices.map((i) => withDisplayStatus(i)),
      documents, meetings, payments, comments, approvals, tickets,
    };
  })
);

publicRoutes.get(
  '/portal/:token/invoices/:id',
  inOrg(async (req, organizationId, org) => {
    const { conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
    if (!isObjectId(req.params.id)) throw new NotFoundError('Invoice');
    const invoice = await Invoice.findOne({ ...clientInvoiceFilter(organizationId, conversionUuid), _id: req.params.id }).lean();
    if (!invoice) throw new NotFoundError('Invoice');
    return { organization: { name: org.name, logo: org.logo || '' }, company: companyProfile(org), invoice: withDisplayStatus(invoice), amountInWords: numberToWordsINR(invoice.total) };
  })
);

publicRoutes.get(
  '/portal/:token/documents/:id',
  route(async (req, res) => {
    const org = await orgFrom(req);
    const organizationId = String(org._id);
    await runWithOrganization(organizationId, async () => {
      const { conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
      const doc = isObjectId(req.params.id)
        ? await OsDocument.findOne({ _id: req.params.id, organizationId, conversionUuid, visibleToClient: true, recordStatus: 'active' }).select('+dataBase64').lean()
        : null;
      if (!doc?.dataBase64) throw new NotFoundError('File');
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName || doc.title)}"`);
      res.send(Buffer.from(doc.dataBase64, 'base64'));
    });
  })
);

// ---------------------------------------------------------------- public tracking by conversion code
publicRoutes.get(
  '/track/:publicCode',
  inOrg(async (req, organizationId, org) => {
    const conversion = await Conversion.findOne({ organizationId, publicCode: String(req.params.publicCode).toUpperCase() }).lean();
    if (!conversion) throw new NotFoundError('Project');
    const uuid = conversion.conversionUuid;
    const [vendor, projects, invoices, payments] = await Promise.all([
      Vendor.findOne({ organizationId, conversionUuid: uuid }).select('companyName').lean(),
      Project.find({ organizationId, conversionUuid: uuid, recordStatus: { $ne: 'archived' } }).select('name service status progress expectedDelivery').lean(),
      Invoice.find(clientInvoiceFilter(organizationId, uuid)).select('invoiceNumber issueDate dueDate total amountPaid status').sort({ issueDate: -1 }).lean(),
      Payment.find({ organizationId, conversionUuid: uuid, recordStatus: 'active' }).select('amount paidAt method').sort({ paidAt: -1 }).lean(),
    ]);
    const milestones = await Milestone.find({ organizationId, projectId: { $in: projects.map((p) => p._id) }, visibleToClient: true, recordStatus: 'active' }).select('projectId name status sortOrder').sort({ sortOrder: 1 }).lean();
    const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const received = invoices.reduce((s, i) => s + (i.amountPaid || 0), 0);
    const live = projects.filter((p) => ACTIVE_PROJECT_STATUSES.includes(normalizeProjectStatus(p.status)));
    const nextDelivery = live.map((p) => p.expectedDelivery).filter(Boolean).sort((a, b) => +new Date(a!) - +new Date(b!))[0] || null;
    return {
      organization: { name: org.name, logo: org.logo || '' },
      publicCode: conversion.publicCode,
      clientName: vendor?.companyName || '',
      projects: projects.map((p) => ({ ...p, status: normalizeProjectStatus(p.status), milestones: milestones.filter((m) => String(m.projectId) === String(p._id)) })),
      money: { invoiced, received, outstanding: Math.max(0, invoiced - received) },
      nextDelivery,
      invoices: invoices.map((i) => withDisplayStatus(i)),
      payments,
    };
  })
);

// ---------------------------------------------------------------- careers
publicRoutes.get(
  '/careers',
  inOrg(async (_req, organizationId, org) => ({
    organization: { name: org.name, logo: org.logo || '' },
    jobs: await Job.find({ organizationId, status: 'published', recordStatus: 'active' }).select('title slug department location employmentType summary publishedAt').sort({ publishedAt: -1 }).lean(),
  }))
);

publicRoutes.get(
  '/careers/:slug',
  inOrg(async (req, organizationId) => {
    const job = await Job.findOne({ organizationId, slug: req.params.slug, status: 'published', recordStatus: 'active' }).lean();
    if (!job) throw new NotFoundError('Job');
    return job;
  })
);

publicRoutes.post(
  '/careers/:slug/apply',
  inOrg(async (req, organizationId) => {
    const job = await Job.findOne({ organizationId, slug: req.params.slug, status: 'published', recordStatus: 'active' }).lean();
    if (!job) throw new NotFoundError('Job');
    const body = parseBody<{ applicantName: string; applicantEmail?: string; applicantPhone?: string; answers?: Record<string, unknown> }>(
      z.object({ applicantName: z.string().min(1, 'Name is required'), applicantEmail: z.string().email('Valid email required').optional(), applicantPhone: z.string().optional(), answers: z.record(z.unknown()).optional() }),
      req.body
    );
    const answers = (job.formFields || []).map((f: { id: string; label: string; type: string; required?: boolean }) => {
      const value = body.answers?.[f.id];
      if (f.required && (value === undefined || value === null || String(value).trim() === '')) throw new ValidationError(`${f.label} is required`);
      return { fieldId: f.id, label: f.label, type: f.type, value: Array.isArray(value) ? value.map(String) : String(value ?? '').slice(0, 5000) };
    });
    const application = await JobApplication.create({
      organizationId, jobId: job._id, jobTitle: job.title, applicantName: body.applicantName, applicantEmail: body.applicantEmail || '',
      applicantPhone: body.applicantPhone || '', answers, createdBy: 'public',
    });
    await notifyStaff(organizationId, { type: 'careers', title: `New application: ${job.title}`, body: body.applicantName, href: `/growth/applications?jobId=${job._id}`, recipientRoles: ['admin', 'hr'], emailCategory: 'careers' });
    return { id: String(application._id), message: 'Application received — thank you!' };
  })
);

// ---------------------------------------------------------------- referral programme
publicRoutes.post(
  '/referrers',
  inOrg(async (req, organizationId) => {
    const body = parseBody<{ fullName: string; email: string; phone?: string }>(
      z.object({ fullName: z.string().min(1, 'Name is required'), email: z.string().email('Valid email required'), phone: z.string().optional() }),
      req.body
    );
    const email = body.email.toLowerCase();
    const existing = await Referrer.findOne({ organizationId, email }).select('referralCode fullName').lean();
    if (existing) return { referralCode: existing.referralCode, existing: true };
    const referralCode = await createUniqueReferralCode(organizationId, body.fullName, body.phone);
    await Referrer.create({ organizationId, fullName: body.fullName, email, phone: body.phone || '', referralCode, createdBy: 'public' });
    return { referralCode, existing: false };
  })
);

publicRoutes.get(
  '/referrers/:code',
  inOrg(async (req, organizationId) => {
    const email = String(req.query.email || '').toLowerCase();
    const referrer = await Referrer.findOne({ organizationId, referralCode: String(req.params.code).toUpperCase() }).lean();
    // The email acts as a lightweight second factor so codes alone can't reveal referral details.
    if (!referrer || referrer.email !== email) throw new NotFoundError('Referrer');
    const referrals = await Referral.find({ organizationId, referrerId: referrer._id, recordStatus: 'active' })
      .select('referredName referredBusiness stage rewardAmount rewardStatus createdAt')
      .sort({ createdAt: -1 })
      .lean();
    return {
      referrer: { fullName: referrer.fullName, referralCode: referrer.referralCode, tier: referrer.tier, successfulReferralCount: referrer.successfulReferralCount, totalRewardEarned: referrer.totalRewardEarned, totalRewardPaid: referrer.totalRewardPaid },
      referrals,
    };
  })
);

publicRoutes.post(
  '/referrals',
  inOrg(async (req, organizationId) => {
    const body = parseBody<{ referralCode: string; referredName: string; referredBusiness?: string; referredEmail?: string; referredPhone?: string; referredNeeds?: string; referrerNotes?: string; consentToIntroEmail?: boolean; mentionReferrerName?: boolean }>(
      z.object({
        referralCode: z.string().min(1, 'Referral code is required'),
        referredName: z.string().min(1, 'Name is required'),
        referredBusiness: z.string().optional(),
        referredEmail: z.string().email().optional().or(z.literal('')),
        referredPhone: z.string().optional(),
        referredNeeds: z.string().optional(),
        referrerNotes: z.string().optional(),
        consentToIntroEmail: z.boolean().optional(),
        mentionReferrerName: z.boolean().optional(),
      }),
      req.body
    );
    if (!body.referredEmail && !body.referredPhone) throw new ValidationError('Add an email or phone for the business you are referring');
    const referrer = await Referrer.findOne({ organizationId, referralCode: body.referralCode.toUpperCase() }).lean();
    if (!referrer) throw new ValidationError('Referral code not found');
    const email = (body.referredEmail || '').toLowerCase();
    const dup = await Referral.exists({ organizationId, $or: [email ? { referredEmail: email } : null, body.referredPhone ? { referredPhone: body.referredPhone } : null].filter(Boolean) as object[] });
    const { referralCode: _code, ...rest } = body;
    void _code;
    const referral = await Referral.create({
      ...rest, referredEmail: email, organizationId, referrerId: referrer._id, source: 'manual_submission', flaggedDuplicate: Boolean(dup), createdBy: referrer.email,
    });
    await ReferralActivity.create({ organizationId, referralId: referral._id, eventType: 'created', toStage: 'submitted', createdBy: referrer.email });
    await notifyStaff(organizationId, { type: 'referral', title: `New referral from ${referrer.fullName}`, body: body.referredName, href: `/growth/referrals`, recipientRoles: ['admin'], emailCategory: 'referrals' });
    return { id: String(referral._id), message: 'Referral submitted — we will be in touch.' };
  })
);

// ---------------------------------------------------------------- EGA + newsletter + magazine
publicRoutes.get(
  '/ega/form',
  inOrg(async (_req, organizationId, org) => {
    const form = await ensureEgaForm(organizationId, 'public');
    return {
      organization: { name: org.name, logo: org.logo || '' },
      title: form.title,
      subtitle: form.subtitle,
      published: form.published,
      fields: form.fields,
    };
  })
);

publicRoutes.post(
  '/ega',
  inOrg(async (req, organizationId) => {
    const body = req.body as Record<string, unknown>;
    const answers = (body.answers && typeof body.answers === 'object' ? body.answers : body) as Record<string, unknown>;
    const fullName = String(answers.fullName || body.fullName || '').trim();
    const email = String(answers.email || body.email || '').trim().toLowerCase();
    if (!fullName) throw new ValidationError('Name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Valid email required');
    if (await EGAApplication.exists({ organizationId, email })) throw new ValidationError('You have already applied with this email');
    const form = await ensureEgaForm(organizationId, 'public');
    for (const field of form.fields as EgaFormField[]) {
      if (!field.required) continue;
      const v = answers[field.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
        throw new ValidationError(`${field.label} is required`);
      }
    }
    const scored = scoreEgaAnswers(form.fields as EgaFormField[], answers);
    const fallback = computeEGAScore(answers);
    const score = scored.score || fallback.score;
    const scoreBreakdown = Object.keys(scored.breakdown).length ? scored.breakdown : fallback.breakdown;
    const allowed = Object.keys(EGAApplication.schema.paths).filter((k) => !['_id', 'organizationId', 'status', 'score', 'scoreBreakdown', 'adminNotes', 'answers', 'recordStatus', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', '__v'].includes(k));
    const data = Object.fromEntries(allowed.filter((k) => answers[k] !== undefined).map((k) => [k, answers[k]]));
    const app = await EGAApplication.create({ ...data, fullName, email, answers, organizationId, score, scoreBreakdown, createdBy: 'public' });
    await notifyStaff(organizationId, { type: 'ega', title: `New EGA application (${score})`, body: fullName, href: '/growth/ega', recipientRoles: ['admin', 'hr'], emailCategory: 'ega' });
    return { id: String(app._id), message: 'Application received.' };
  })
);

publicRoutes.post(
  '/newsletter',
  inOrg(async (req, organizationId) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Valid email required');
    await NewsletterSubscriber.updateOne(
      { organizationId, email },
      { $set: { status: 'subscribed', source: String(req.body?.source || 'website') }, $setOnInsert: { organizationId, email, createdBy: 'public' } },
      { upsert: true }
    );
    return { message: 'Subscribed.' };
  })
);

publicRoutes.get(
  '/magazine',
  inOrg(async (_req, organizationId, org) => {
    const [issues, articles] = await Promise.all([
      MagazineIssue.find({ organizationId, status: 'published', recordStatus: 'active' }).sort({ publishedAt: -1 }).lean(),
      MagazineArticle.find({ organizationId, status: 'published', recordStatus: 'active' }).sort({ publishedAt: -1 }).limit(40).lean(),
    ]);
    return { organization: { name: org.name, logo: org.logo || '', slug: org.slug }, issues, articles };
  })
);

publicRoutes.get(
  '/magazine/:articleSlug',
  inOrg(async (req, organizationId, org) => {
    const article = await MagazineArticle.findOne({ organizationId, slug: String(req.params.articleSlug).toLowerCase(), status: 'published', recordStatus: 'active' }).lean();
    if (!article) throw new NotFoundError('Article');
    const more = await MagazineArticle.find({ organizationId, status: 'published', recordStatus: 'active', _id: { $ne: article._id } }).sort({ publishedAt: -1 }).limit(4).select('title slug excerpt publishedAt').lean();
    return { organization: { name: org.name, logo: org.logo || '', slug: org.slug }, article, more };
  })
);

publicRoutes.post(
  '/portal/:token/comments',
  inOrg(async (req, organizationId) => {
    const { conversion, vendor, conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
    const body = String(req.body?.body || '').trim();
    if (!body) throw new ValidationError('Write a message');
    const row = await PortalComment.create({
      organizationId, conversionUuid, authorType: 'client', authorName: vendor.contactPerson || vendor.companyName, body, createdBy: 'client',
    });
    await notifyStaff(organizationId, { type: 'portal', title: `Client message from ${vendor.companyName}`, body, href: `/clients/${conversion._id}`, recipientRoles: ['admin', 'project_manager'] });
    return row;
  })
);

publicRoutes.post(
  '/portal/:token/approvals/:id',
  inOrg(async (req, organizationId) => {
    const { conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
    const status = z.enum(['approved', 'changes_requested']).parse(req.body?.status);
    const row = await PortalApproval.findOne({ _id: req.params.id, organizationId, conversionUuid });
    if (!row) throw new NotFoundError('Approval');
    row.status = status;
    row.clientComment = String(req.body?.comment || '');
    row.decidedAt = new Date();
    await row.save();
    return row;
  })
);

publicRoutes.post(
  '/portal/:token/tickets',
  inOrg(async (req, organizationId) => {
    const { vendor, conversionUuid } = await resolvePortal(organizationId, req.params.token as string);
    const b = parseBody<{ title: string; body?: string; kind?: string }>(
      z.object({ title: z.string().min(2), body: z.string().optional(), kind: z.enum(['change_request', 'brief', 'issue', 'question']).optional() }),
      req.body
    );
    const row = await PortalTicket.create({
      organizationId, conversionUuid, title: b.title, body: b.body || '', kind: b.kind || 'question', createdBy: vendor.companyName,
    });
    await notifyStaff(organizationId, { type: 'portal', title: `Client request: ${b.title}`, body: b.body, href: '/clients', recipientRoles: ['admin', 'project_manager'] });
    return { id: String(row._id), message: 'Request received. Your team will follow up.' };
  })
);

