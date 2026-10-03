import { Router } from 'express';
import { z } from 'zod';
import {
  AgencyAsset, KnowledgeCategory, KnowledgeArticle, ContentPost, LeaveRequest, SowTemplate, SowDocument,
  PortalComment, PortalApproval, PortalTicket, User,
} from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, parseBody } from '../../../shared/utils/crud.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { permissionsAllow } from '../../../shared/types/index.js';

const MAX_FILE = 6 * 1024 * 1024;
const filePrepare = (data: Record<string, unknown>) => {
  if (data.dataBase64) {
    const raw = String(data.dataBase64).replace(/^data:[^;]+;base64,/, '');
    const size = Math.floor((raw.length * 3) / 4);
    if (size > MAX_FILE) throw new ValidationError('File must be under 6MB');
    const mime = String(data.mimeType || 'application/octet-stream');
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.includes('pdf') || mime.includes('word') ? 'document' : 'other';
    Object.assign(data, { dataBase64: raw, size, mimeType: mime, kind });
  }
  return data;
};

export const assetRoutes = crudRouter({
  model: AgencyAsset,
  resource: 'documents',
  entityType: 'asset',
  label: 'Asset',
  searchFields: ['title', 'fileName', 'folder', 'tags'],
  filterFields: ['folder', 'kind', 'projectId'],
  createSchema: z.object({
    title: z.string().min(1), folder: z.string().optional(), tags: z.array(z.string()).optional(),
    fileName: z.string().optional(), mimeType: z.string().optional(), dataBase64: z.string().optional(),
    projectId: z.string().optional(), conversionUuid: z.string().optional(), notes: z.string().optional(),
  }),
  updateSchema: z.object({ title: z.string().optional(), folder: z.string().optional(), tags: z.array(z.string()).optional(), notes: z.string().optional() }),
  prepare: async (data, _ctx, existing) => (existing ? data : filePrepare(data)),
  transform: (d) => {
    const { dataBase64, ...rest } = d;
    return { ...rest, hasFile: Boolean(d.size || dataBase64) };
  },
  extend: (router) => {
    router.get('/:id/download', authorize('documents:read'), route(async (req, res) => {
      const doc = await AgencyAsset.findOne({ _id: req.params.id, organizationId: req.user!.organizationId }).select('+dataBase64').lean();
      if (!doc?.dataBase64) throw new NotFoundError('File');
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName || doc.title)}"`);
      res.send(Buffer.from(doc.dataBase64, 'base64'));
    }));
  },
});

const DEFAULT_KB = [
  { cat: 'Onboarding', articles: [
    { title: 'First week at the agency', body: 'Meet your pod, set up tools, shadow a client call, and log your first tracker row. Ask your manager for the current handbook links.' },
    { title: 'How we run a client', body: 'Lead → conversion → project workspace → weekly update in the client portal. Never leave a client without a next date.' },
  ] },
  { cat: 'Sales playbook', articles: [
    { title: 'Discovery questions', body: 'What does success look like in 90 days? Who signs? What have they tried? Budget range? Competitors?' },
    { title: 'Handoff to delivery', body: 'Won deals get a SOW from templates, then a project with milestones before kickoff.' },
  ] },
  { cat: 'Delivery checklist', articles: [
    { title: 'Kickoff', body: 'Confirm scope, store brand assets in the library, share portal link, book weekly status.' },
  ] },
];

async function seedKnowledge(organizationId: string, email: string) {
  if (await KnowledgeCategory.exists({ organizationId })) return;
  for (const [i, block] of DEFAULT_KB.entries()) {
    const cat = await KnowledgeCategory.create({ organizationId, name: block.cat, sortOrder: i, createdBy: email });
    await KnowledgeArticle.insertMany(block.articles.map((a) => ({
      organizationId, categoryId: cat._id, title: a.title, body: a.body, status: 'published', audience: 'all', createdBy: email,
    })));
  }
}

export const knowledgeCategoryRoutes = crudRouter({
  model: KnowledgeCategory,
  resource: 'knowledge',
  entityType: 'knowledge_category',
  label: 'Category',
  searchFields: ['name'],
  defaultSort: { sortOrder: 1, name: 1 },
  createSchema: z.object({ name: z.string().min(1), description: z.string().optional(), sortOrder: z.coerce.number().optional() }),
  updateSchema: z.object({ name: z.string().min(1).optional(), description: z.string().optional(), sortOrder: z.coerce.number().optional() }),
  scope: async (ctx) => {
    await seedKnowledge(ctx.organizationId, ctx.actor.email);
    return {};
  },
});

export const knowledgeArticleRoutes = crudRouter({
  model: KnowledgeArticle,
  resource: 'knowledge',
  entityType: 'knowledge_article',
  label: 'Article',
  searchFields: ['title', 'body'],
  filterFields: ['categoryId', 'status', 'audience'],
  createSchema: z.object({ title: z.string().min(1), body: z.string().min(1), categoryId: z.string().optional(), audience: z.enum(['all', 'sales', 'delivery', 'ops']).optional(), status: z.enum(['draft', 'published']).optional() }),
  updateSchema: z.object({ title: z.string().optional(), body: z.string().optional(), categoryId: z.string().optional(), audience: z.enum(['all', 'sales', 'delivery', 'ops']).optional(), status: z.enum(['draft', 'published']).optional() }),
});

export const contentCalendarRoutes = crudRouter({
  model: ContentPost,
  resource: 'campaigns',
  entityType: 'content_post',
  label: 'Content',
  searchFields: ['title', 'caption', 'channel'],
  filterFields: ['status', 'channel'],
  dateField: 'scheduledAt',
  defaultSort: { scheduledAt: 1, createdAt: -1 },
  createSchema: z.object({
    title: z.string().min(1), channel: z.enum(['instagram', 'linkedin', 'facebook', 'youtube', 'blog', 'magazine', 'email', 'other']).optional(),
    status: z.enum(['idea', 'draft', 'scheduled', 'published', 'cancelled']).optional(),
    scheduledAt: z.string().optional(), ownerName: z.string().optional(), caption: z.string().optional(),
    articleId: z.string().optional(), assetId: z.string().optional(), notes: z.string().optional(),
  }),
  updateSchema: z.object({
    title: z.string().optional(), channel: z.string().optional(), status: z.enum(['idea', 'draft', 'scheduled', 'published', 'cancelled']).optional(),
    scheduledAt: z.string().optional(), ownerName: z.string().optional(), caption: z.string().optional(),
    articleId: z.string().optional().nullable(), notes: z.string().optional(),
  }),
});

function leaveDays(start: Date, end: Date) {
  return Math.max(1, Math.round((+end - +start) / 86_400_000) + 1);
}

export const leaveRoutes = Router();
leaveRoutes.use(authenticate);

leaveRoutes.get('/', authorize('leaves:read'), route(async (req) => {
  const filter: Record<string, unknown> = { organizationId: req.user!.organizationId, recordStatus: 'active' };
  const canAll = permissionsAllow(req.user!.permissions, 'leaves:*') || permissionsAllow(req.user!.permissions, '*') || req.user!.role === 'admin' || req.user!.role === 'hr' || req.user!.role === 'manager';
  if (!canAll) filter.userId = req.user!.id;
  if (req.query.status && req.query.status !== 'all') filter.status = String(req.query.status);
  return LeaveRequest.find(filter).sort({ startDate: -1 }).limit(300).lean();
}));

leaveRoutes.post('/', authorize('leaves:write'), route(async (req, res) => {
  const b = parseBody<{ type?: string; startDate: string; endDate: string; reason?: string }>(
    z.object({ type: z.enum(['casual', 'sick', 'earned', 'unpaid', 'other']).optional(), startDate: z.string(), endDate: z.string(), reason: z.string().optional() }),
    req.body
  );
  const startDate = new Date(b.startDate);
  const endDate = new Date(b.endDate);
  if (endDate < startDate) throw new ValidationError('End date must be after start date');
  const user = await User.findById(req.user!.id).select('firstName lastName').lean();
  const row = await LeaveRequest.create({
    organizationId: req.user!.organizationId, userId: req.user!.id,
    employeeName: user ? `${user.firstName} ${user.lastName}`.trim() : req.user!.name,
    type: b.type || 'casual', startDate, endDate, days: leaveDays(startDate, endDate), reason: b.reason || '',
    createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  res.status(201);
  return row;
}));

leaveRoutes.post('/:id/decide', authorize('leaves:write'), route(async (req) => {
  const canReview = permissionsAllow(req.user!.permissions, 'leaves:*') || permissionsAllow(req.user!.permissions, '*') || ['admin', 'hr', 'manager'].includes(req.user!.role);
  if (!canReview) throw new ValidationError('Only managers can approve leave');
  const status = z.enum(['approved', 'rejected']).parse(req.body?.status);
  const row = await LeaveRequest.findOne({ _id: req.params.id, organizationId: req.user!.organizationId });
  if (!row) throw new NotFoundError('Leave request');
  row.status = status;
  row.reviewerName = req.user!.name || req.user!.email;
  row.reviewerComment = String(req.body?.comment || '');
  row.decidedAt = new Date();
  row.updatedBy = req.user!.email;
  await row.save();
  return row;
}));

export const sowTemplateRoutes = crudRouter({
  model: SowTemplate,
  resource: 'documents',
  entityType: 'sow_template',
  label: 'SOW template',
  searchFields: ['name'],
  createSchema: z.object({ name: z.string().min(1), body: z.string().min(1), defaultTermDays: z.coerce.number().optional() }),
  updateSchema: z.object({ name: z.string().optional(), body: z.string().optional(), defaultTermDays: z.coerce.number().optional() }),
  scope: async (ctx) => {
    if (!(await SowTemplate.exists({ organizationId: ctx.organizationId }))) {
      await SowTemplate.create({
        organizationId: ctx.organizationId,
        name: 'Standard digital project',
        defaultTermDays: 14,
        body: `Scope\n- Discovery and kickoff\n- Design and development as agreed in the proposal\n- Two rounds of revisions\n\nTimeline\n- Kickoff within 5 working days of signature\n\nPayment\n- 50% to start, 50% on delivery\n\nThe client provides brand assets within 7 days of kickoff.`,
        createdBy: ctx.actor.email,
      });
    }
    return {};
  },
});

export const sowDocumentRoutes = crudRouter({
  model: SowDocument,
  resource: 'documents',
  entityType: 'sow',
  label: 'Statement of work',
  searchFields: ['title', 'clientName', 'projectName'],
  filterFields: ['status'],
  createSchema: z.object({
    title: z.string().min(1), templateId: z.string().optional(), clientName: z.string().optional(),
    projectName: z.string().optional(), conversionUuid: z.string().optional(), dealId: z.string().optional(),
    body: z.string().optional(),
  }),
  updateSchema: z.object({ title: z.string().optional(), body: z.string().optional(), status: z.enum(['draft', 'sent', 'signed', 'void']).optional(), clientName: z.string().optional(), projectName: z.string().optional() }),
  prepare: async (data, ctx, existing) => {
    if (existing) return data;
    if (data.templateId && !data.body) {
      const tpl = await SowTemplate.findOne({ _id: data.templateId, organizationId: ctx.organizationId }).lean();
      if (tpl) data.body = tpl.body;
    }
    const html = `<html><body style="font-family:Inter,Arial,sans-serif;padding:40px;color:#111">
      <h1>${String(data.title || 'Statement of Work')}</h1>
      <p><strong>Client:</strong> ${String(data.clientName || '—')} · <strong>Project:</strong> ${String(data.projectName || '—')}</p>
      <div style="white-space:pre-wrap;line-height:1.6">${String(data.body || '')}</div>
    </body></html>`;
    data.html = html;
    return data;
  },
  extend: (router) => {
    router.get('/:id/print', authorize('documents:read'), route(async (req, res) => {
      const doc = await SowDocument.findOne({ _id: req.params.id, organizationId: req.user!.organizationId }).lean();
      if (!doc) throw new NotFoundError('Statement of work');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(doc.html || `<pre>${doc.body || ''}</pre>`);
    }));
  },
});

export const portalOpsRoutes = Router();
portalOpsRoutes.use(authenticate);

portalOpsRoutes.get('/:conversionUuid/inbox', authorize('vendors:read'), route(async (req) => {
  const conversionUuid = req.params.conversionUuid as string;
  const org = req.user!.organizationId;
  const [comments, approvals, tickets] = await Promise.all([
    PortalComment.find({ organizationId: org, conversionUuid }).sort({ createdAt: -1 }).limit(100).lean(),
    PortalApproval.find({ organizationId: org, conversionUuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    PortalTicket.find({ organizationId: org, conversionUuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
  ]);
  return { comments, approvals, tickets };
}));

portalOpsRoutes.post('/:conversionUuid/comments', authorize('vendors:write'), route(async (req) => {
  const body = z.string().min(1).parse(req.body?.body);
  return PortalComment.create({
    organizationId: req.user!.organizationId, conversionUuid: req.params.conversionUuid,
    authorType: 'staff', authorName: req.user!.name || req.user!.email, body, createdBy: req.user!.email,
  });
}));

portalOpsRoutes.post('/:conversionUuid/approvals', authorize('vendors:write'), route(async (req) => {
  const b = parseBody<{ title: string; detail?: string; kind?: string }>(z.object({ title: z.string().min(1), detail: z.string().optional(), kind: z.enum(['proof', 'sow', 'brief', 'other']).optional() }), req.body);
  return PortalApproval.create({
    organizationId: req.user!.organizationId, conversionUuid: req.params.conversionUuid, ...b, createdBy: req.user!.email,
  });
}));

portalOpsRoutes.patch('/tickets/:id', authorize('vendors:write'), route(async (req) => {
  const b = parseBody<{ status?: string; staffReply?: string }>(z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(), staffReply: z.string().optional() }), req.body);
  const row = await PortalTicket.findOneAndUpdate({ _id: req.params.id, organizationId: req.user!.organizationId }, { $set: { ...b, updatedBy: req.user!.email } }, { new: true });
  if (!row) throw new NotFoundError('Ticket');
  return row;
}));
