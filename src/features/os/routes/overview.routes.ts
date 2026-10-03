import { Router } from 'express';
import { z } from 'zod';
import {
  Lead, Conversion, Vendor, Project, ProjectMember, Task, Invoice, Meeting, FollowUp, Transaction, TrackerRow,
  RecurringPayment, ActivityEvent, Notification, User, SalesCustomer, Referrer, ServiceCatalog, IndustryCatalog,
} from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, oid, escapeRegex, type CrudContext } from '../../../shared/utils/crud.js';
import { actorFrom, notifyStaff } from '../../../shared/os/activity.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { permissionsAllow } from '../../../shared/types/index.js';
import { withDisplayStatus, displayInvoiceStatus, outstandingOf } from '../../../shared/os/money.js';
import {
  ACTIVE_PROJECT_STATUSES, TRACKER_DONE_STATUSES, DEFAULT_SERVICES, DEFAULT_INDUSTRIES, normalizeProjectStatus,
} from '../../../shared/constants/os.js';
import { LEAD_STATUSES } from '../../../models/Lead.js';
import { sendNotificationEmail } from '../../../shared/utils/mailer.js';
import { notificationRecipients } from '../../../shared/os/company.js';
import type { OsDoc } from '../../../models/os/base.js';
import { salesPortalHref } from '../services/sales-portal.service.js';

const DAY = 86_400_000;
const inr = (n: number) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
const fullName = (u?: { firstName?: string; lastName?: string; email?: string } | null) =>
  u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '' : '';

export const overviewRoutes = Router();
overviewRoutes.use(authenticate);

overviewRoutes.get(
  '/dashboard',
  authorize('dashboard:read'),
  route(async (req) => {
    const user = req.user!;
    const org = oid(user.organizationId);
    const me = oid(user.id);
    const canSeeAll = permissionsAllow(user.permissions, 'projects:write') || permissionsAllow(user.permissions, '*');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + DAY);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const open = { $nin: ['completed', 'cancelled'] };

    const [leads, conversions, vendors, projects, tasks, invoices, meetings, followUps, transactions, trackerRows, myMemberships, salesCustomers, referrerCount, staff, unread] =
      await Promise.all([
        Lead.find({ organizationId: org, isArchived: { $ne: true } }).select('status estimatedValue').lean(),
        Conversion.countDocuments({ organizationId: org }),
        Vendor.countDocuments({ organizationId: org, recordStatus: 'active' }),
        Project.find({ organizationId: org, recordStatus: { $ne: 'archived' } }).select('name status expectedDelivery primaryPocUserId').lean(),
        Task.find({ organizationId: org, recordStatus: { $ne: 'archived' }, status: open, ...(canSeeAll ? {} : { assignedTo: me }) })
          .select('title status dueDate assignedTo').populate('assignedTo', 'firstName lastName email').sort({ dueDate: 1 }).lean(),
        Invoice.find({ organizationId: org, recordStatus: 'active' }).select('status total amountPaid dueDate paymentDate').lean(),
        Meeting.find({ organizationId: org, recordStatus: 'active', startsAt: { $gte: now } }).sort({ startsAt: 1 }).limit(5).select('title startsAt').lean(),
        FollowUp.find({ organizationId: org, status: 'scheduled', scheduledAt: { $lte: todayEnd } }).sort({ scheduledAt: 1 }).limit(6).lean(),
        Transaction.find({ organizationId: org, recordStatus: 'active' }).select('type amount date').lean(),
        TrackerRow.find({ organizationId: org, recordStatus: 'active' }).select('poc dependency status projectName taskName date').sort({ date: -1 }).lean(),
        ProjectMember.find({ organizationId: org, userId: me }).select('projectId').lean(),
        SalesCustomer.countDocuments({ organizationId: org, recordStatus: 'active' }),
        Referrer.countDocuments({ organizationId: org }),
        canSeeAll ? User.find({ organizationId: org, isActive: true }).select('firstName lastName email role').lean() : [],
        Notification.countDocuments({ organizationId: org, userId: me, readAt: null }),
      ]);

    const openLeads = leads.filter((l) => !['converted', 'lost'].includes(l.status));
    const pipelineValue = openLeads.reduce((s, l) => s + (l.estimatedValue || 0), 0);
    const salesCounts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, leads.filter((l) => l.status === s).length]));
    const activeProjects = projects.filter((p) => ACTIVE_PROJECT_STATUSES.includes(normalizeProjectStatus(p.status)));
    const dueSoon = activeProjects.filter((p) => p.expectedDelivery && +p.expectedDelivery >= +now && +p.expectedDelivery <= +now + 7 * DAY);

    const issued = invoices.filter((i) => !['draft', 'cancelled'].includes(i.status));
    const invoiced = issued.reduce((s, i) => s + (i.total || 0), 0);
    const received = invoices.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + (i.amountPaid || 0), 0);
    const overdueInvoices = issued.filter((i) => displayInvoiceStatus({ status: i.status === 'sent' ? 'issued' : i.status, dueDate: i.dueDate, amountPaid: i.amountPaid || 0, total: i.total || 0 }) === 'overdue');
    const overdueAmount = overdueInvoices.reduce((s, i) => s + outstandingOf(i.total, i.amountPaid), 0);
    const monthPaid = invoices.filter((i) => i.paymentDate && i.paymentDate >= monthStart).reduce((s, i) => s + (i.amountPaid || 0), 0);
    const quarterPaid = invoices.filter((i) => i.paymentDate && i.paymentDate >= quarterStart).reduce((s, i) => s + (i.amountPaid || 0), 0);
    const otherIncome = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const totalSpent = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const monthSpent = transactions.filter((t) => t.type === 'expense' && t.date >= monthStart).reduce((s, t) => s + t.amount, 0);

    const todayTasks = tasks.filter((t) => t.dueDate && t.dueDate >= todayStart && t.dueDate < todayEnd);
    const overdueTasks = tasks.filter((t) => t.dueDate && t.dueDate < todayStart);
    const blockedTasks = tasks.filter((t) => t.status === 'blocked');

    const openTracker = trackerRows.filter((r) => !TRACKER_DONE_STATUSES.includes(r.status));
    const memberIds = new Set(myMemberships.map((m) => String(m.projectId)));
    const owned = projects.filter((p) => String(p.primaryPocUserId || '') === user.id);
    const working = projects.filter((p) => memberIds.has(String(p._id)) || String(p.primaryPocUserId || '') === user.id);

    const workload = canSeeAll
      ? staff.map((s) => {
          const id = String(s._id);
          const mine = trackerRows.filter((r) => r.poc === id);
          const openRows = mine.filter((r) => !TRACKER_DONE_STATUSES.includes(r.status));
          const myTasks = tasks.filter((t) => String((t.assignedTo as OsDoc | null)?._id || '') === id);
          return {
            id, name: fullName(s), email: s.email, role: s.role,
            active: openRows.length + myTasks.length,
            completed: mine.length - openRows.length,
            blocked: openRows.filter((r) => r.status === 'blocked').length + myTasks.filter((t) => t.status === 'blocked').length,
            overdue: myTasks.filter((t) => t.dueDate && t.dueDate < todayStart).length,
            total: mine.length + myTasks.length,
          };
        })
      : [];

    return {
      canSeeAll,
      unread,
      taskStats: { open: tasks.length, today: todayTasks.length, overdue: overdueTasks.length, blocked: blockedTasks.length, trackerOpen: openTracker.length },
      growth: { referrers: referrerCount, totalClients: vendors + salesCustomers, salesCustomers },
      tasks: tasks.slice(0, 8).map((t) => ({ id: String(t._id), title: t.title, status: t.status, dueDate: t.dueDate, assignee: fullName(t.assignedTo as never), mine: String((t.assignedTo as OsDoc | null)?._id || '') === user.id })),
      tracker: openTracker.slice(0, 8).map((r) => ({ id: String(r._id), label: r.taskName, projectName: r.projectName, status: r.status, mine: r.poc === user.id })),
      myProjects: { owned: owned.length, working: working.length, list: working.slice(0, 8).map((p) => ({ id: String(p._id), name: p.name || 'Untitled project' })) },
      workload,
      kpis: { received, activeClients: vendors, activeProjects: activeProjects.length, openLeads: openLeads.length, pipelineValue, outstanding: Math.max(0, invoiced - received) },
      pipeline: { counts: salesCounts, conversionRate: leads.length ? Math.round((conversions / leads.length) * 100) : 0 },
      operations: { dueSoon: dueSoon.length, meetings },
      finance: { invoiced, collected: received, outstanding: Math.max(0, invoiced - received), overdue: overdueAmount, monthPaid, quarterPaid, otherIncome, totalSpent, monthSpent, net: received + otherIncome - totalSpent },
      attention: {
        overdueInvoices: { count: overdueInvoices.length, amount: overdueAmount },
        followUps: followUps.map((f) => ({ id: String(f._id), notes: f.title || 'Follow-up', dueAt: f.scheduledAt })),
        deliveryRisk: { dueSoon: dueSoon.length, overdueTasks: overdueTasks.length },
      },
    };
  })
);

overviewRoutes.post(
  '/dashboard/alerts',
  authorize('tasks:write'),
  route(async (req) => {
    const orgId = req.user!.organizationId;
    const org = oid(orgId);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + DAY);
    const [invoices, overdueTasks, followUps, recurring, admins] = await Promise.all([
      Invoice.find({ organizationId: org, recordStatus: 'active', status: { $nin: ['draft', 'cancelled'] } }).lean(),
      Task.find({ organizationId: org, recordStatus: { $ne: 'archived' }, status: { $nin: ['completed', 'cancelled'] }, dueDate: { $lt: todayStart } }).select('title assignedTo').lean(),
      FollowUp.find({ organizationId: org, status: 'scheduled', scheduledAt: { $lte: todayEnd } }).select('title assignedTo').lean(),
      RecurringPayment.find({ organizationId: org, recordStatus: 'active', status: 'active', nextDueAt: { $lte: new Date(+now + 7 * DAY) } }).sort({ nextDueAt: 1 }).lean(),
      User.find({ organizationId: org, isActive: true, role: 'admin' }).select('email').lean(),
    ]);
    const overdue = invoices.map((i) => withDisplayStatus(i)).filter((i) => i.displayStatus === 'overdue');
    const overdueAmount = overdue.reduce((s, i) => s + i.outstanding, 0);
    const date = now.toISOString().slice(0, 10);
    const lines = [
      `Overdue invoices: ${overdue.length} (${inr(overdueAmount)})`,
      `Overdue tasks: ${overdueTasks.length}`,
      `Follow-ups due: ${followUps.length}`,
      `Recurring payments due (7d): ${recurring.length}`,
      ...(overdue.length ? overdue.slice(0, 5).map((i) => `Invoice ${i.invoiceNumber}`) : ['No overdue invoices.']),
      ...(overdueTasks.length ? overdueTasks.slice(0, 5).map((t) => `Task: ${t.title}`) : ['No overdue tasks.']),
      ...(recurring.length ? recurring.slice(0, 5).map((r) => `${r.title} (${inr(r.amount)} · ${r.nextDueAt.toISOString().slice(0, 10)})`) : ['No recurring payments due soon.']),
    ];
    const digestTo = [...new Set([...admins.map((a) => a.email.toLowerCase()), ...(await notificationRecipients(orgId, 'alerts'))])];
    await Promise.all(digestTo.map((to) => sendNotificationEmail(to, { title: `Daily alerts · ${date}`, eyebrow: 'Ops alert', href: '/', ctaLabel: 'Open dashboard →', lines }, undefined, { organizationId: orgId })));

    if (recurring.length) {
      await notifyStaff(orgId, { type: 'recurring_payment', title: `Recurring payments due (${recurring.length})`, body: recurring.slice(0, 8).map((r) => `${r.title}: ${inr(r.amount)} · ${r.nextDueAt.toISOString().slice(0, 10)}`).join(' · '), href: '/recurring-payments', recipientRoles: ['finance'] });
    }
    const adminIds = new Set(admins.map((a) => String(a._id)));
    const byAssignee = new Map<string, string[]>();
    for (const t of overdueTasks) {
      const id = String(t.assignedTo || '');
      if (!id || adminIds.has(id)) continue;
      byAssignee.set(id, [...(byAssignee.get(id) || []), t.title]);
    }
    for (const [id, titles] of byAssignee) {
      await notifyStaff(orgId, { type: 'task_overdue_alert', title: `You have ${titles.length} overdue task(s)`, body: titles.slice(0, 6).join(' · '), href: '/tasks?view=my', recipientUserIds: [id] });
    }
    const byFollowUp = new Map<string, string[]>();
    for (const f of followUps) {
      const id = String(f.assignedTo || '');
      if (!id || adminIds.has(id)) continue;
      byFollowUp.set(id, [...(byFollowUp.get(id) || []), f.title || 'Follow-up']);
    }
    for (const [id, notes] of byFollowUp) {
      await notifyStaff(orgId, { type: 'followup_due_alert', title: `${notes.length} follow-up(s) due`, body: notes.slice(0, 5).join(' · '), href: '/follow-ups', recipientUserIds: [id] });
    }
    const assignees = new Set([...byAssignee.keys(), ...byFollowUp.keys()]).size;
    return { message: `Alerts emailed to ${admins.length} admin(s)${assignees ? ` + ${assignees} assignee(s)` : ''}.` };
  })
);

overviewRoutes.post(
  '/dashboard/nudge',
  authorize('dashboard:read'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const { userId, name, active = 0, overdue = 0 } = req.body || {};
    if (!userId) throw new ValidationError('Missing teammate');
    const href = await salesPortalHref(actor.organizationId, String(userId), '/tasks?view=my');
    await notifyStaff(actor.organizationId, {
      type: 'workload_nudge', title: `Workload check-in from ${actor.name || actor.email}`,
      body: `You currently have ${active} active task(s)${overdue ? ` (${overdue} overdue)` : ''}. Please update statuses or ask for help if blocked.`,
      href, recipientUserIds: [String(userId)],
    });
    return { message: `Nudge sent to ${name || 'teammate'}.` };
  })
);

overviewRoutes.get(
  '/search',
  authorize('search:read'),
  route(async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { redirect: null, conversions: [], clients: [], invoices: [], leads: [], projects: [] };
    const org = oid(req.user!.organizationId);
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    const exact = await Conversion.findOne({ organizationId: org, $or: [{ publicCode: q.toUpperCase() }, { conversionUuid: q }] }).select('publicCode').lean();
    if (exact) return { redirect: `/conversions/${exact.publicCode}` };
    const invoice = await Invoice.findOne({ organizationId: org, invoiceNumber: { $regex: `^${escapeRegex(q)}$`, $options: 'i' } }).select('_id').lean();
    if (invoice) return { redirect: `/invoices/${invoice._id}` };
    const [conversions, clients, leads, projects] = await Promise.all([
      Conversion.find({ organizationId: org, publicCode: rx }).select('publicCode conversionUuid').limit(20).lean(),
      Vendor.find({ organizationId: org, $or: [{ companyName: rx }, { email: rx }, { contactPerson: rx }] }).select('companyName email conversionUuid').limit(20).lean(),
      Lead.find({ organizationId: org, $or: [{ company: rx }, { email: rx }, { firstName: rx }, { lastName: rx }] }).select('firstName lastName company email status').limit(20).lean(),
      Project.find({ organizationId: org, name: rx }).select('name status').limit(20).lean(),
    ]);
    return { redirect: null, conversions, clients, leads, projects };
  })
);

overviewRoutes.get(
  '/activity',
  authorize('activity:read'),
  route(async (req) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { organizationId: oid(req.user!.organizationId) };
    if (q.entityType) filter.entityType = q.entityType;
    if (q.conversionUuid) filter.conversionUuid = q.conversionUuid;
    const events = await ActivityEvent.find(filter).sort({ createdAt: -1 }).limit(Math.min(200, Number(q.limit) || 100)).lean();
    const uuids = [...new Set(events.map((e) => e.conversionUuid).filter(Boolean))];
    const conversions = await Conversion.find({ organizationId: filter.organizationId, conversionUuid: { $in: uuids } }).select('conversionUuid publicCode').lean();
    const codeBy = new Map(conversions.map((c) => [c.conversionUuid, c.publicCode]));
    return events.map((e) => ({ ...e, actor: e.actorName || e.createdBy || 'System', publicCode: codeBy.get(e.conversionUuid) || null }));
  })
);

overviewRoutes.get(
  '/analytics',
  authorize('analytics:read'),
  route(async (req) => {
    const org = oid(req.user!.organizationId);
    const [leads, conversions, invoices, industries] = await Promise.all([
      Lead.find({ organizationId: org, isArchived: { $ne: true } }).select('sector industry status source createdAt').lean(),
      Conversion.countDocuments({ organizationId: org }),
      Invoice.find({ organizationId: org, recordStatus: 'active', status: { $ne: 'cancelled' } }).select('status total amountPaid dueDate').lean(),
      IndustryCatalog.find({ organizationId: org, isActive: true }).select('slug name sector').lean(),
    ]);
    const issued = invoices.filter((i) => i.status !== 'draft').map((i) => withDisplayStatus(i));
    const received = invoices.reduce((s, i) => s + (i.amountPaid || 0), 0);
    const invoiced = issued.reduce((s, i) => s + (i.total || 0), 0);
    const now = Date.now();
    const aging = [
      { label: '0–30 days', min: 0, max: 30 },
      { label: '31–60 days', min: 31, max: 60 },
      { label: '61+ days', min: 61, max: 3650 },
    ].map((b) => ({
      label: b.label,
      amount: issued
        .filter((i) => i.outstanding > 0 && i.dueDate)
        .filter((i) => {
          const age = Math.floor((now - new Date(i.dueDate!).getTime()) / DAY);
          return age >= b.min && age <= b.max;
        })
        .reduce((s, i) => s + i.outstanding, 0),
    }));
    const sectorOf = (l: OsDoc) => {
      const raw = String(l.sector || l.industry || '').trim();
      if (!raw) return 'Unspecified';
      const ind = industries.find((i) => i.slug === raw || i.name === raw);
      return ind?.sector || raw;
    };
    const counts = new Map<string, number>();
    for (const l of leads) counts.set(sectorOf(l), (counts.get(sectorOf(l)) || 0) + 1);
    const sectors = [...counts.entries()].map(([sector, count]) => ({ sector, count })).sort((a, b) => b.count - a.count);
    const sources = new Map<string, number>();
    for (const l of leads) sources.set(l.source || 'other', (sources.get(l.source || 'other') || 0) + 1);
    return {
      conversionRate: leads.length ? Math.round((conversions / leads.length) * 100) : 0,
      received, invoiced,
      overdueCount: issued.filter((i) => i.displayStatus === 'overdue').length,
      aging, sectors, topSector: sectors[0]?.sector || '—',
      sources: [...sources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    };
  })
);

// ---------------------------------------------------------------- catalog
async function seedCatalog(organizationId: string, email: string) {
  await Promise.all([
    ...DEFAULT_SERVICES.map((s) => ServiceCatalog.updateOne({ organizationId, slug: s.slug }, { $setOnInsert: { ...s, organizationId, isActive: true, createdBy: email } }, { upsert: true })),
    ...DEFAULT_INDUSTRIES.map((i) => IndustryCatalog.updateOne({ organizationId, slug: i.slug }, { $setOnInsert: { ...i, organizationId, isActive: true, createdBy: email } }, { upsert: true })),
  ]);
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const catalogPrepare = async (data: Record<string, unknown>, _ctx: CrudContext, existing?: OsDoc) => {
  if (!existing && !data.slug && data.name) data.slug = slugify(String(data.name));
  return data;
};

const catalogScope = async (ctx: CrudContext) => {
  const count = await ServiceCatalog.countDocuments({ organizationId: ctx.organizationId });
  if (!count) await seedCatalog(ctx.organizationId, ctx.actor.email);
  return {};
};

export const serviceCatalogRoutes = crudRouter({
  model: ServiceCatalog,
  resource: 'services',
  readPermission: 'dashboard:read',
  writePermission: 'settings:write',
  entityType: 'service',
  label: 'Service',
  searchFields: ['name', 'slug'],
  filterFields: ['isActive'],
  defaultSort: { name: 1 },
  createSchema: z.object({ name: z.string().min(1, 'Name is required'), slug: z.string().optional(), isActive: z.boolean().optional() }),
  updateSchema: z.object({ name: z.string().min(1).optional(), isActive: z.boolean().optional() }),
  scope: catalogScope,
  prepare: catalogPrepare,
});

export const industryCatalogRoutes = crudRouter({
  model: IndustryCatalog,
  resource: 'industries',
  readPermission: 'dashboard:read',
  writePermission: 'settings:write',
  entityType: 'industry',
  label: 'Industry',
  searchFields: ['name', 'slug', 'sector'],
  filterFields: ['isActive', 'sector'],
  defaultSort: { sector: 1, name: 1 },
  createSchema: z.object({ name: z.string().min(1, 'Name is required'), slug: z.string().optional(), sector: z.string().optional(), isActive: z.boolean().optional() }),
  updateSchema: z.object({ name: z.string().min(1).optional(), sector: z.string().optional(), isActive: z.boolean().optional() }),
  scope: catalogScope,
  prepare: catalogPrepare,
});
