import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Model } from 'mongoose';
import {
  SalesEmployee, SalesLead, SalesDeal, SalesCustomer, SalesCall, SalesMeeting, SalesFollowUp, SalesQuotation,
  SalesProposal, SalesTask, SalesTarget, SalesTerritory, SalesApproval, SalesAttendance, SalesWorkStatus,
  SalesActivityEvent, SalesMessage, User, EGAApplication, nextSequence,
} from '../../../models/index.js';
import { authenticate } from '../../../shared/middleware/auth.js';
import { route, parseBody, oid, isObjectId, escapeRegex } from '../../../shared/utils/crud.js';
import { notifyStaff, writeAudit, actorFrom } from '../../../shared/os/activity.js';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../../../shared/errors/index.js';
import { permissionsAllow, type AuthenticatedRequest } from '../../../shared/types/index.js';
import { hashPassword } from '../../../shared/utils/jwt.js';
import {
  SALES_MODULES, DEFAULT_EMPLOYEE_MODULES, SALES_ADMIN_ONLY_MODULES, SALES_LEAD_SOURCES, SALES_LEAD_TEMPERATURES,
  SALES_LEAD_STATUSES, SALES_DEAL_STAGES, SALES_LOST_REASONS, SALES_CALL_OUTCOMES, SALES_MEETING_TYPES,
  SALES_MEETING_STATUSES, SALES_FOLLOWUP_TYPES, SALES_QUOTATION_STATUSES, SALES_PROPOSAL_STATUSES,
  SALES_TASK_STATUSES, SALES_APPROVAL_TYPES, SALES_TARGET_PERIODS, SALES_TERRITORY_TYPES, SALES_EMPLOYEE_STATUSES,
  LEAD_PRIORITIES,
} from '../../../shared/constants/os.js';
import type { OsDoc } from '../../../models/os/base.js';
import { salesPortalHref } from '../services/sales-portal.service.js';
import { callingRoutes } from '../calling/routes.js';
import { buildCallAnalytics, loggedCallMatch, withCallerNames } from '../calling/analytics.js';
import { toDialablePhone } from '../calling/phone.js';

type ModuleKey = (typeof SALES_MODULES)[number];

interface SalesContext {
  employee: OsDoc;
  employeeId: string;
  isSalesAdmin: boolean;
  modules: Record<ModuleKey, boolean>;
  name: string;
}

type SalesRequest = AuthenticatedRequest & { sales?: SalesContext };

const DAY = 86_400_000;
const revenueOf = (d: OsDoc) => d.finalOffer || d.value || 0;

export function effectiveModules(isSalesAdmin: boolean, overrides: Record<string, unknown> = {}) {
  const map = Object.fromEntries(SALES_MODULES.map((k) => [k, isSalesAdmin || DEFAULT_EMPLOYEE_MODULES.includes(k)])) as Record<ModuleKey, boolean>;
  if (isSalesAdmin) return map;
  for (const [k, v] of Object.entries(overrides || {})) if ((SALES_MODULES as readonly string[]).includes(k)) map[k as ModuleKey] = Boolean(v);
  for (const k of SALES_ADMIN_ONLY_MODULES) map[k as ModuleKey] = false;
  return map;
}

async function nextEmployeeCode(organizationId: string, isSalesAdmin: boolean) {
  const seq = await nextSequence(organizationId, isSalesAdmin ? 'sales:SA' : 'sales:SE', await SalesEmployee.countDocuments({ organizationId, isSalesAdmin }));
  return `${isSalesAdmin ? 'SA' : 'SE'}-${String(seq).padStart(4, '0')}`;
}

/** Loads the caller's Sales CRM identity; company admins and sales users are provisioned on first use. */
async function salesContext(req: SalesRequest, _res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const companyAdmin = permissionsAllow(user.permissions, 'sales_crm:write');
    const isSalesRole = user.role === 'sales';
    let employee = await SalesEmployee.findOne({ organizationId: user.organizationId, userId: user.id }).lean();
    if (!employee && (companyAdmin || isSalesRole)) {
      employee = (await SalesEmployee.create({
        organizationId: user.organizationId, userId: user.id, isSalesAdmin: companyAdmin, employeeCode: await nextEmployeeCode(user.organizationId, companyAdmin),
        createdBy: user.email, updatedBy: user.email,
      })).toObject();
    }
    if (!employee) throw new ForbiddenError('You are not part of the Sales CRM');
    if (employee.status !== 'active' && !companyAdmin) throw new ForbiddenError('Your Sales CRM access is not active');
    const isSalesAdmin = Boolean(employee.isSalesAdmin || companyAdmin);
    req.sales = {
      employee, employeeId: String(employee._id), isSalesAdmin,
      modules: effectiveModules(isSalesAdmin, employee.moduleOverrides), name: user.name || user.email,
    };
    next();
  } catch (error) {
    next(error);
  }
}

const needModule = (key: ModuleKey) => (req: SalesRequest, _res: Response, next: NextFunction) =>
  req.sales?.modules[key] ? next() : next(new ForbiddenError('This module is not enabled for your account'));

const needAdmin = (req: SalesRequest, _res: Response, next: NextFunction) =>
  req.sales?.isSalesAdmin ? next() : next(new ForbiddenError('Sales admin access required'));

const ctx = (req: AuthenticatedRequest) => (req as SalesRequest).sales!;
const orgOf = (req: AuthenticatedRequest) => req.user!.organizationId;

async function logSales(req: AuthenticatedRequest, type: string, title: string, extra: { detail?: string; leadId?: unknown; dealId?: unknown; metadata?: Record<string, unknown> } = {}) {
  const s = ctx(req);
  await SalesActivityEvent.create({
    organizationId: orgOf(req), type, title, detail: extra.detail || '', actorEmployeeId: s.employeeId, actorName: s.name,
    leadId: extra.leadId, dealId: extra.dealId, metadata: extra.metadata || {}, createdBy: req.user!.email,
  });
}

/** Employees only see their own records; sales admins see everything. */
const ownScope = (req: AuthenticatedRequest, field = 'ownerEmployeeId') => {
  const s = ctx(req);
  const q = req.query as Record<string, string>;
  if (!s.isSalesAdmin) return { [field]: oid(s.employeeId) };
  return q.employeeId && isObjectId(q.employeeId) ? { [field]: oid(q.employeeId) } : {};
};

async function findOwned(model: Model<OsDoc>, req: AuthenticatedRequest, id: string, field = 'ownerEmployeeId') {
  if (!isObjectId(id)) throw new NotFoundError('Record');
  const doc = await model.findOne({ _id: id, organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req, field) });
  if (!doc) throw new NotFoundError('Record');
  return doc;
}

async function employeeNames(organizationId: string, employees: OsDoc[]) {
  const users = await User.find({ organizationId, _id: { $in: employees.map((e) => e.userId) } }).select('firstName lastName email lastLoginAt').lean();
  return new Map(employees.map((e) => {
    const u = users.find((x) => String(x._id) === String(e.userId));
    return [String(e._id), { name: u ? `${u.firstName} ${u.lastName}`.trim() : e.employeeCode, email: u?.email || '', lastLoginAt: (u as OsDoc | undefined)?.lastLoginAt }];
  }));
}

export const salesCrmRoutes = Router();
salesCrmRoutes.use(authenticate, salesContext as never);
salesCrmRoutes.use('/calling', needModule('comm.calls') as never, callingRoutes);

// ---------------------------------------------------------------- me + dashboards
salesCrmRoutes.get('/me', route(async (req) => {
  const s = ctx(req);
  return { employee: s.employee, isSalesAdmin: s.isSalesAdmin, modules: s.modules, name: s.name };
}));

/** BDA Home / My Day — overdue work, today's agenda, hot leads, quick stats. */
salesCrmRoutes.get('/my-day', route(async (req) => {
  const s = ctx(req);
  const org = oid(orgOf(req));
  const me = oid(s.employeeId);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(+todayStart + DAY);
  const leadScope = s.isSalesAdmin ? {} : { assignedEmployeeId: me };
  const ownerScope = s.isSalesAdmin ? {} : { ownerEmployeeId: me };
  const callScope = s.isSalesAdmin ? {} : { employeeId: me };

  const [overdueFollowUps, todayFollowUps, todayMeetings, todayTasks, overdueTasks, openTasks, hotLeads, todayCalls, openLeads, pendingApprovals] = await Promise.all([
    SalesFollowUp.find({ organizationId: org, recordStatus: 'active', status: 'pending', dueAt: { $lt: todayStart }, ...ownerScope }).sort({ dueAt: 1 }).limit(20).lean(),
    SalesFollowUp.find({ organizationId: org, recordStatus: 'active', status: 'pending', dueAt: { $gte: todayStart, $lt: todayEnd }, ...ownerScope }).sort({ dueAt: 1 }).limit(20).lean(),
    SalesMeeting.find({ organizationId: org, recordStatus: 'active', status: 'scheduled', startsAt: { $gte: todayStart, $lt: todayEnd }, ...ownerScope }).sort({ startsAt: 1 }).limit(20).lean(),
    SalesTask.find({ organizationId: org, recordStatus: 'active', status: { $ne: 'completed' }, dueDate: { $gte: todayStart, $lt: todayEnd }, ...ownerScope }).sort({ dueDate: 1 }).limit(20).lean(),
    SalesTask.find({ organizationId: org, recordStatus: 'active', status: { $ne: 'completed' }, dueDate: { $lt: todayStart }, ...ownerScope }).sort({ dueDate: 1 }).limit(20).lean(),
    SalesTask.find({ organizationId: org, recordStatus: 'active', status: { $ne: 'completed' }, ...ownerScope }).sort({ dueDate: 1, createdAt: -1 }).limit(30).lean(),
    SalesLead.find({ organizationId: org, recordStatus: 'active', status: { $nin: ['converted', 'lost'] }, temperature: { $in: ['hot', 'warm'] }, ...leadScope }).sort({ updatedAt: -1 }).limit(12).lean(),
    SalesCall.find({ organizationId: org, calledAt: { $gte: todayStart, $lt: todayEnd }, ...callScope }).sort({ calledAt: -1 }).limit(20).lean(),
    SalesLead.countDocuments({ organizationId: org, recordStatus: 'active', status: { $nin: ['converted', 'lost'] }, ...leadScope }),
    s.isSalesAdmin
      ? SalesApproval.countDocuments({ organizationId: org, status: 'pending' })
      : SalesApproval.countDocuments({ organizationId: org, status: 'pending', requesterEmployeeId: me }),
  ]);

  return {
    date: todayStart.toISOString().slice(0, 10),
    stats: {
      openLeads,
      overdueFollowUps: overdueFollowUps.length,
      overdueTasks: overdueTasks.length,
      openTasks: openTasks.length,
      todayMeetings: todayMeetings.length,
      todayCalls: todayCalls.length,
      pendingApprovals,
    },
    overdueFollowUps,
    todayFollowUps,
    todayMeetings,
    todayTasks,
    overdueTasks,
    openTasks,
    hotLeads,
    todayCalls,
    callAnalytics: await buildCallAnalytics(orgOf(req), s.isSalesAdmin ? undefined : s.employeeId),
  };
}));

salesCrmRoutes.get('/dashboard', route(async (req) => {
  const s = ctx(req);
  const org = oid(orgOf(req));
  const now = new Date();
  if (s.isSalesAdmin) {
    const [activeEmployees, leads, pendingApprovals, overdueTasks, pendingEga, totalEga, employees] = await Promise.all([
      SalesEmployee.countDocuments({ organizationId: org, status: 'active' }),
      SalesLead.find({ organizationId: org, recordStatus: 'active' }).select('status assignedEmployeeId').lean(),
      SalesApproval.countDocuments({ organizationId: org, status: 'pending' }),
      SalesTask.countDocuments({ organizationId: org, recordStatus: 'active', status: { $ne: 'completed' }, dueDate: { $lt: now } }),
      EGAApplication.countDocuments({ organizationId: org, status: 'pending' }),
      EGAApplication.countDocuments({ organizationId: org }),
      SalesEmployee.find({ organizationId: org, status: 'active', isSalesAdmin: false }).sort({ employeeCode: 1 }).limit(12).lean(),
    ]);
    const open = leads.filter((l) => !['converted', 'lost'].includes(l.status));
    const names = await employeeNames(orgOf(req), employees);
    const loads = employees.map((e) => ({ id: String(e._id), name: names.get(String(e._id))?.name, openLeads: open.filter((l) => String(l.assignedEmployeeId || '') === String(e._id)).length }));
    const maxLoad = Math.max(1, ...loads.map((l) => l.openLeads));
    const converted = leads.filter((l) => l.status === 'converted').length;
    return {
      role: 'admin',
      stats: { activeEmployees, openLeads: open.length, unassigned: open.filter((l) => !l.assignedEmployeeId).length, converted, pendingApprovals, overdueTasks, pendingEga, totalEga },
      leadStatus: Object.fromEntries(SALES_LEAD_STATUSES.map((st) => [st, leads.filter((l) => l.status === st).length])),
      conversionRate: leads.length ? Math.round((converted / leads.length) * 100) : 0,
      workload: loads.map((l) => ({ ...l, pct: l.openLeads === 0 ? 0 : Math.max(20, Math.round((l.openLeads / maxLoad) * 100)) })),
      callAnalytics: await buildCallAnalytics(orgOf(req)),
    };
  }
  const me = oid(s.employeeId);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(+todayStart + DAY);
  const [leads, deals, followUps, meetings, tasks] = await Promise.all([
    SalesLead.find({ organizationId: org, recordStatus: 'active', assignedEmployeeId: me }).select('status contactPerson company createdAt').sort({ createdAt: -1 }).lean(),
    SalesDeal.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: me }).select('dealName stage value probability finalOffer closedAt').lean(),
    SalesFollowUp.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: me, status: 'pending', dueAt: { $lt: todayEnd } }).sort({ dueAt: 1 }).limit(8).lean(),
    SalesMeeting.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: me, status: 'scheduled', startsAt: { $gte: todayStart } }).sort({ startsAt: 1 }).limit(5).lean(),
    SalesTask.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: me, status: { $ne: 'completed' } }).sort({ dueDate: 1 }).limit(8).lean(),
  ]);
  const openDeals = deals.filter((d) => !['won', 'lost'].includes(d.stage));
  const won = deals.filter((d) => d.stage === 'won');
  return {
    role: 'employee',
    stats: {
      myLeads: leads.length, newLeads: leads.filter((l) => l.status === 'new').length,
      openDeals: openDeals.length, pipelineValue: openDeals.reduce((t, d) => t + (d.value || 0), 0),
      weightedPipeline: Math.round(openDeals.reduce((t, d) => t + ((d.value || 0) * (d.probability || 0)) / 100, 0)),
      revenue: won.reduce((t, d) => t + revenueOf(d), 0), followUpsDue: followUps.length,
    },
    recentLeads: leads.slice(0, 6), followUps, meetings, tasks,
    callAnalytics: await buildCallAnalytics(orgOf(req), s.employeeId),
  };
}));

// ---------------------------------------------------------------- employees
const employeeSchema = z.object({
  name: z.string().min(2, 'Name is required'),
  email: z.string().email('Valid email required'),
  password: z.string().min(8, 'Password must be at least 8 characters').optional().or(z.literal('')),
  department: z.string().optional(),
  team: z.string().optional(),
  territory: z.string().optional(),
  phone: z.string().optional(),
  isSalesAdmin: z.boolean().optional(),
});

salesCrmRoutes.get('/employees', route(async (req) => {
  const org = orgOf(req);
  const employees = await SalesEmployee.find({ organizationId: org, recordStatus: 'active' }).sort({ isSalesAdmin: -1, employeeCode: 1 }).lean();
  const names = await employeeNames(org, employees);
  const [leadCounts, wonDeals] = await Promise.all([
    SalesLead.aggregate([{ $match: { organizationId: oid(org), recordStatus: 'active', status: { $nin: ['converted', 'lost'] } } }, { $group: { _id: '$assignedEmployeeId', n: { $sum: 1 } } }]),
    SalesDeal.find({ organizationId: org, recordStatus: 'active', stage: 'won' }).select('ownerEmployeeId value finalOffer').lean(),
  ]);
  return employees.map((e) => ({
    ...e, ...names.get(String(e._id)),
    live: Boolean(names.get(String(e._id))?.lastLoginAt && Date.now() - +new Date(names.get(String(e._id))!.lastLoginAt) < 30 * 60_000),
    openLeads: leadCounts.find((c) => String(c._id) === String(e._id))?.n || 0,
    revenue: wonDeals.filter((d) => String(d.ownerEmployeeId) === String(e._id)).reduce((t, d) => t + revenueOf(d), 0),
  }));
}));

salesCrmRoutes.post('/employees', needAdmin as never, route(async (req, res) => {
  const org = orgOf(req);
  const input = parseBody<z.infer<typeof employeeSchema>>(employeeSchema, req.body);
  const email = input.email.toLowerCase().trim();
  let user: { _id: unknown } | null = await User.findOne({ organizationId: org, email }).select('_id').lean();
  if (!user) {
    if (!input.password) throw new ValidationError('Set a password for the new account');
    const [firstName, ...rest] = input.name.trim().split(/\s+/);
    user = (await User.create({ organizationId: org, email, firstName, lastName: rest.join(' ') || '-', role: 'sales', isActive: true, password: await hashPassword(input.password) })).toObject();
  }
  if (await SalesEmployee.exists({ organizationId: org, userId: user!._id })) throw new ConflictError('This person is already in the Sales CRM');
  const isSalesAdmin = Boolean(input.isSalesAdmin);
  const employee = await SalesEmployee.create({
    organizationId: org, userId: user!._id, isSalesAdmin, employeeCode: await nextEmployeeCode(org, isSalesAdmin),
    department: input.department?.trim() || 'Sales', team: input.team || '', territory: input.territory || '', phone: input.phone || '',
    createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  await logSales(req, 'employee_created', `${input.name} added to the Sales CRM${isSalesAdmin ? ' as Sales Admin' : ''} by ${ctx(req).name}`, { metadata: { employeeId: String(employee._id) } });
  await writeAudit(actorFrom(req.user!), { entityType: 'SalesEmployee', entityId: String(employee._id), field: 'employee_created', oldValue: '', newValue: email });
  res.status(201);
  return employee;
}));

salesCrmRoutes.get('/employees/:id', needAdmin as never, route(async (req) => {
  const org = orgOf(req);
  if (!isObjectId(req.params.id)) throw new NotFoundError('Employee');
  const employee = await SalesEmployee.findOne({ _id: req.params.id, organizationId: org }).lean();
  if (!employee) throw new NotFoundError('Employee');
  const names = await employeeNames(org, [employee]);
  const [leads, deals, calls, meetings, activity] = await Promise.all([
    SalesLead.countDocuments({ organizationId: org, recordStatus: 'active', assignedEmployeeId: employee._id }),
    SalesDeal.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: employee._id }).select('stage value finalOffer').lean(),
    SalesCall.countDocuments({ organizationId: org, employeeId: employee._id }),
    SalesMeeting.countDocuments({ organizationId: org, ownerEmployeeId: employee._id }),
    SalesActivityEvent.find({ organizationId: org, actorEmployeeId: employee._id }).sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  const won = deals.filter((d) => d.stage === 'won');
  return {
    employee: { ...employee, ...names.get(String(employee._id)) },
    modules: effectiveModules(Boolean(employee.isSalesAdmin), employee.moduleOverrides),
    stats: { leads, deals: deals.length, won: won.length, revenue: won.reduce((t, d) => t + revenueOf(d), 0), calls, meetings },
    activity,
  };
}));

salesCrmRoutes.patch('/employees/:id', needAdmin as never, route(async (req) => {
  const body = parseBody<{ status?: string; department?: string; team?: string; territory?: string; phone?: string }>(
    z.object({ status: z.enum(SALES_EMPLOYEE_STATUSES).optional(), department: z.string().optional(), team: z.string().optional(), territory: z.string().optional(), phone: z.string().optional() }),
    req.body
  );
  const employee = await SalesEmployee.findOne({ _id: req.params.id, organizationId: orgOf(req) });
  if (!employee) throw new NotFoundError('Employee');
  const prev = employee.status;
  Object.assign(employee, body, { updatedBy: req.user!.email });
  await employee.save();
  if (body.status && body.status !== prev) await writeAudit(actorFrom(req.user!), { entityType: 'SalesEmployee', entityId: String(employee._id), field: 'status', oldValue: prev, newValue: body.status });
  return employee;
}));

salesCrmRoutes.put('/employees/:id/permissions', needAdmin as never, route(async (req) => {
  const desired = z.record(z.boolean()).parse(req.body?.modules || {});
  const employee = await SalesEmployee.findOne({ _id: req.params.id, organizationId: orgOf(req) });
  if (!employee) throw new NotFoundError('Employee');
  if (employee.isSalesAdmin) throw new ValidationError('Sales admins always have every module');
  const defaults = effectiveModules(false);
  const overrides: Record<string, boolean> = {};
  for (const key of SALES_MODULES) {
    if (SALES_ADMIN_ONLY_MODULES.includes(key) || desired[key] === undefined) continue;
    if (desired[key] !== defaults[key]) overrides[key] = desired[key];
  }
  const before = JSON.stringify(employee.moduleOverrides || {});
  employee.moduleOverrides = overrides;
  employee.markModified('moduleOverrides');
  employee.updatedBy = req.user!.email;
  await employee.save();
  await writeAudit(actorFrom(req.user!), { entityType: 'SalesEmployee', entityId: String(employee._id), field: 'permission_changed', oldValue: before, newValue: JSON.stringify(overrides) });
  await logSales(req, 'permission_changed', 'Module access updated', { metadata: { employeeId: String(employee._id) } });
  return { modules: effectiveModules(false, overrides) };
}));

salesCrmRoutes.delete('/employees/:id', needAdmin as never, route(async (req) => {
  const s = ctx(req);
  if (req.params.id === s.employeeId) throw new ValidationError("You can't delete your own account");
  const employee = await SalesEmployee.findOneAndUpdate({ _id: req.params.id, organizationId: orgOf(req) }, { $set: { recordStatus: 'archived', status: 'inactive', updatedBy: req.user!.email } });
  if (!employee) throw new NotFoundError('Employee');
  // Unassign their open leads so admins can re-route them instead of leaving orphans.
  await SalesLead.updateMany({ organizationId: orgOf(req), assignedEmployeeId: employee._id, status: { $nin: ['converted', 'lost'] } }, { $unset: { assignedEmployeeId: 1 } });
  await writeAudit(actorFrom(req.user!), { entityType: 'SalesEmployee', entityId: String(employee._id), field: 'employee_deleted', oldValue: employee.employeeCode, newValue: '' });
  return { id: String(employee._id) };
}));

// ---------------------------------------------------------------- leads
const leadSchema = z.object({
  contactPerson: z.string().min(2, 'Contact person is required'),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  website: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  source: z.enum(SALES_LEAD_SOURCES).optional(),
  campaign: z.string().optional(),
  industry: z.string().optional(),
  requirement: z.string().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  temperature: z.enum(SALES_LEAD_TEMPERATURES).optional(),
  territory: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

salesCrmRoutes.get('/leads', needModule('leads.management') as never, route(async (req) => {
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { organizationId: oid(orgOf(req)), recordStatus: 'active', ...ownScope(req, 'assignedEmployeeId') };
  if (q.status && q.status !== 'all') filter.status = q.status;
  if (q.temperature) filter.temperature = q.temperature;
  if (q.source) filter.source = q.source;
  if (q.unassigned === 'true' && ctx(req).isSalesAdmin) filter.assignedEmployeeId = null;
  if (q.search?.trim()) {
    const rx = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
    filter.$or = [{ contactPerson: rx }, { company: rx }, { email: rx }, { phone: rx }];
  }
  const leads = await SalesLead.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const employees = await SalesEmployee.find({ organizationId: orgOf(req), _id: { $in: leads.map((l) => l.assignedEmployeeId).filter(Boolean) } }).lean();
  const names = await employeeNames(orgOf(req), employees);
  return leads.map((l) => ({ ...l, assignedName: l.assignedEmployeeId ? names.get(String(l.assignedEmployeeId))?.name || '' : '' }));
}));

salesCrmRoutes.post('/leads', needModule('leads.management') as never, route(async (req, res) => {
  const s = ctx(req);
  const input = parseBody<z.infer<typeof leadSchema>>(leadSchema, req.body);
  const lead = await SalesLead.create({ ...input, organizationId: orgOf(req), assignedEmployeeId: s.isSalesAdmin ? undefined : s.employeeId, createdBy: req.user!.email, updatedBy: req.user!.email });
  await logSales(req, 'lead_created', `Lead created: ${input.contactPerson}${input.company ? ` (${input.company})` : ''}`, { leadId: lead._id });
  res.status(201);
  return lead;
}));

salesCrmRoutes.get('/leads/:id', needModule('leads.management') as never, route(async (req) => {
  const lead = await findOwned(SalesLead, req, req.params.id as string, 'assignedEmployeeId');
  const org = orgOf(req);
  const [callRows, meetings, followUps, deals, activity, messages] = await Promise.all([
    SalesCall.find({ organizationId: org, leadId: lead._id, recordStatus: 'active', ...loggedCallMatch() }).sort({ calledAt: -1 }).lean(),
    SalesMeeting.find({ organizationId: org, leadId: lead._id, recordStatus: 'active' }).sort({ startsAt: -1 }).lean(),
    SalesFollowUp.find({ organizationId: org, leadId: lead._id, recordStatus: 'active' }).sort({ dueAt: -1 }).lean(),
    SalesDeal.find({ organizationId: org, leadId: lead._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    SalesActivityEvent.find({ organizationId: org, leadId: lead._id }).sort({ createdAt: -1 }).limit(40).lean(),
    SalesMessage.find({ organizationId: org, leadId: lead._id, recordStatus: 'active' }).sort({ sentAt: -1 }).limit(40).lean(),
  ]);
  const calls = await withCallerNames(org, callRows);
  return { lead, calls, meetings, followUps, deals, activity, messages };
}));

salesCrmRoutes.patch('/leads/:id', needModule('leads.management') as never, route(async (req) => {
  const lead = await findOwned(SalesLead, req, req.params.id as string, 'assignedEmployeeId');
  const input = parseBody<Partial<z.infer<typeof leadSchema>>>(leadSchema.partial(), req.body);
  Object.assign(lead, input, { updatedBy: req.user!.email });
  await lead.save();
  await logSales(req, 'lead_updated', 'Lead details updated', { leadId: lead._id });
  return lead;
}));

salesCrmRoutes.post('/leads/:id/status', needModule('leads.management') as never, route(async (req) => {
  const lead = await findOwned(SalesLead, req, req.params.id as string, 'assignedEmployeeId');
  const status = z.enum(SALES_LEAD_STATUSES).parse(req.body?.status);
  const prev = lead.status;
  lead.status = status;
  if (status === 'contacted' && !lead.lastContactedAt) lead.lastContactedAt = new Date();
  lead.updatedBy = req.user!.email;
  await lead.save();
  await logSales(req, 'lead_updated', `Lead moved from ${prev} to ${status}`, { leadId: lead._id });
  return lead;
}));

salesCrmRoutes.post('/leads/:id/qualification', needModule('leads.qualification') as never, route(async (req) => {
  const lead = await findOwned(SalesLead, req, req.params.id as string, 'assignedEmployeeId');
  const b = req.body || {};
  Object.assign(lead, {
    qualificationNotes: b.qualificationNotes || '', budget: Number(b.budget || 0) || 0, timeline: b.timeline || '',
    decisionMaker: b.decisionMaker || '', businessNeed: b.businessNeed || '',
    probability: Math.max(0, Math.min(100, Number(b.probability || 0) || 0)), nextAction: b.nextAction || '', updatedBy: req.user!.email,
  });
  await lead.save();
  await logSales(req, 'lead_updated', 'Qualification updated', { leadId: lead._id });
  return lead;
}));

salesCrmRoutes.post('/leads/:id/assign', needAdmin as never, route(async (req) => {
  const org = orgOf(req);
  const employeeId = String(req.body?.employeeId || '');
  const [lead, employee] = await Promise.all([
    isObjectId(req.params.id) ? SalesLead.findOne({ _id: req.params.id, organizationId: org, recordStatus: 'active' }) : null,
    isObjectId(employeeId) ? SalesEmployee.findOne({ _id: employeeId, organizationId: org, status: 'active' }).lean() : null,
  ]);
  if (!lead || !employee) throw new NotFoundError('Lead or employee');
  const prev = lead.assignedEmployeeId ? String(lead.assignedEmployeeId) : '';
  lead.assignedEmployeeId = employee._id;
  lead.updatedBy = req.user!.email;
  await lead.save();
  await logSales(req, 'lead_assigned', 'Lead assigned', { leadId: lead._id, metadata: { assignedToEmployeeId: employeeId } });
  await writeAudit(actorFrom(req.user!), { entityType: 'SalesLead', entityId: String(lead._id), field: 'assignedEmployeeId', oldValue: prev, newValue: employeeId });
  await notifyStaff(org, {
    type: 'sales_lead_assigned',
    title: `New lead assigned: ${lead.contactPerson}`,
    body: lead.company || '',
    href: await salesPortalHref(org, String(employee.userId), `/sales-crm/leads/${lead._id}`),
    recipientUserIds: [String(employee.userId)],
  });
  return lead;
}));

salesCrmRoutes.delete('/leads/:id', needModule('leads.management') as never, route(async (req) => {
  const lead = await findOwned(SalesLead, req, req.params.id as string, 'assignedEmployeeId');
  lead.recordStatus = 'archived';
  lead.updatedBy = req.user!.email;
  await lead.save();
  await logSales(req, 'lead_updated', 'Lead archived', { leadId: lead._id });
  return { id: String(lead._id) };
}));

// ---------------------------------------------------------------- deals
const dealSchema = z.object({
  dealName: z.string().min(2, 'Deal name is required'),
  leadId: z.string().optional(),
  value: z.coerce.number().min(0).optional(),
  probability: z.coerce.number().min(0).max(100).optional(),
  expectedCloseDate: z.string().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  notes: z.string().optional(),
});

salesCrmRoutes.get('/deals', needModule('sales.deals') as never, route(async (req) => {
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { organizationId: oid(orgOf(req)), recordStatus: 'active', ...ownScope(req) };
  if (q.stage && q.stage !== 'all') filter.stage = q.stage === 'open' ? { $nin: ['won', 'lost'] } : q.stage;
  if (q.search?.trim()) filter.dealName = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
  return SalesDeal.find(filter).populate('leadId', 'contactPerson company').sort({ lastActivityAt: -1, createdAt: -1 }).limit(500).lean();
}));

salesCrmRoutes.post('/deals', needModule('sales.deals') as never, route(async (req, res) => {
  const input = parseBody<z.infer<typeof dealSchema>>(dealSchema, req.body);
  if (input.leadId && !(await SalesLead.exists({ _id: input.leadId, organizationId: orgOf(req) }))) throw new ValidationError('Lead not found');
  const deal = await SalesDeal.create({
    ...input, leadId: input.leadId || undefined, value: input.value || 0, probability: input.probability ?? 10,
    expectedCloseDate: input.expectedCloseDate || undefined, ownerEmployeeId: ctx(req).employeeId, stage: 'new', lastActivityAt: new Date(),
    organizationId: orgOf(req), createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  await logSales(req, 'deal_created', `Deal created: ${deal.dealName}`, { dealId: deal._id, leadId: deal.leadId });
  res.status(201);
  return deal;
}));

salesCrmRoutes.get('/deals/:id', needModule('sales.deals') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  const org = orgOf(req);
  const [lead, quotations, proposals, approvals, activity] = await Promise.all([
    deal.leadId ? SalesLead.findById(deal.leadId).lean() : null,
    SalesQuotation.find({ organizationId: org, dealId: deal._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    SalesProposal.find({ organizationId: org, dealId: deal._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    SalesApproval.find({ organizationId: org, dealId: deal._id }).sort({ createdAt: -1 }).lean(),
    SalesActivityEvent.find({ organizationId: org, dealId: deal._id }).sort({ createdAt: -1 }).limit(40).lean(),
  ]);
  return { deal, lead, quotations, proposals, approvals, activity };
}));

salesCrmRoutes.patch('/deals/:id', needModule('sales.deals') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  const input = parseBody<Partial<z.infer<typeof dealSchema>>>(dealSchema.partial(), req.body);
  Object.assign(deal, input, { lastActivityAt: new Date(), updatedBy: req.user!.email });
  await deal.save();
  await logSales(req, 'deal_updated', 'Deal details updated', { dealId: deal._id });
  return deal;
}));

async function convertWonLead(req: AuthenticatedRequest, deal: OsDoc) {
  if (!deal.leadId) return;
  const lead = await SalesLead.findByIdAndUpdate(deal.leadId, { $set: { status: 'converted', updatedBy: req.user!.email } }, { new: true }).lean();
  if (!lead) return;
  const customer = await SalesCustomer.findOne({ organizationId: orgOf(req), sourceLeadId: lead._id });
  if (customer) {
    customer.totalRevenue = (customer.totalRevenue || 0) + revenueOf(deal);
    await customer.save();
  } else {
    await SalesCustomer.create({
      organizationId: orgOf(req), name: lead.contactPerson, company: lead.company, industry: lead.industry, city: lead.city, email: lead.email, phone: lead.phone,
      ownerEmployeeId: deal.ownerEmployeeId, sourceLeadId: lead._id, totalRevenue: revenueOf(deal), createdBy: req.user!.email,
    });
  }
}

salesCrmRoutes.post('/deals/:id/stage', needModule('sales.pipeline') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  const stage = z.enum(SALES_DEAL_STAGES).parse(req.body?.stage);
  const prev = deal.stage;
  if (prev === stage) return deal;
  deal.stage = stage;
  deal.lastActivityAt = new Date();
  if (stage === 'won' || stage === 'lost') deal.closedAt = new Date();
  if (stage === 'won' && !deal.finalOffer) deal.finalOffer = deal.value;
  deal.updatedBy = req.user!.email;
  await deal.save();
  if (stage === 'won') await convertWonLead(req, deal.toObject());
  await logSales(req, stage === 'won' ? 'deal_won' : stage === 'lost' ? 'deal_lost' : 'deal_moved', `Deal moved from ${prev} to ${stage}`, { dealId: deal._id });
  return deal;
}));

salesCrmRoutes.post('/deals/:id/negotiation', needModule('sales.negotiation') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  const b = req.body || {};
  Object.assign(deal, {
    competitor: b.competitor || '', discountRequested: Number(b.discountRequested || 0) || 0, discountApproved: Number(b.discountApproved || 0) || 0,
    currentOffer: Number(b.currentOffer || 0) || 0, notes: b.notes || deal.notes, lastActivityAt: new Date(), updatedBy: req.user!.email,
  });
  await deal.save();
  await logSales(req, 'deal_updated', 'Negotiation updated', { dealId: deal._id });
  return deal;
}));

salesCrmRoutes.post('/deals/:id/close', needModule('sales.closure') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  const b = parseBody<{ outcome: 'won' | 'lost'; finalOffer?: number; paymentStatus?: string; lostReason?: string; lostNotes?: string }>(
    z.object({ outcome: z.enum(['won', 'lost']), finalOffer: z.coerce.number().optional(), paymentStatus: z.string().optional(), lostReason: z.enum([...SALES_LOST_REASONS, ''] as [string, ...string[]]).optional(), lostNotes: z.string().optional() }),
    req.body
  );
  Object.assign(deal, {
    stage: b.outcome, closedAt: new Date(), finalOffer: Number(b.finalOffer || deal.value) || 0, paymentStatus: b.paymentStatus || '',
    lostReason: b.outcome === 'lost' ? b.lostReason || 'other' : '', lostNotes: b.lostNotes || '', updatedBy: req.user!.email,
  });
  await deal.save();
  if (b.outcome === 'won') await convertWonLead(req, deal.toObject());
  await logSales(req, b.outcome === 'won' ? 'deal_won' : 'deal_lost', `Deal ${b.outcome}: ${deal.dealName}`, { dealId: deal._id });
  return deal;
}));

salesCrmRoutes.delete('/deals/:id', needModule('sales.deals') as never, route(async (req) => {
  const deal = await findOwned(SalesDeal, req, req.params.id as string);
  deal.recordStatus = 'archived';
  await deal.save();
  return { id: String(deal._id) };
}));

salesCrmRoutes.get('/customers', needModule('customers.management') as never, route(async (req) =>
  SalesCustomer.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) }).sort({ customerSince: -1 }).limit(500).lean()
));

// ---------------------------------------------------------------- calls, meetings, follow-ups
salesCrmRoutes.get('/calls', needModule('comm.calls') as never, route(async (req) => {
  const rows = await SalesCall.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req, 'employeeId'), ...loggedCallMatch() })
    .populate('leadId', 'contactPerson company').sort({ calledAt: -1 }).limit(300).lean();
  return withCallerNames(orgOf(req), rows);
}));

salesCrmRoutes.post('/calls', needModule('comm.calls') as never, route(async (req, res) => {
  const b = parseBody<{ leadId?: string; durationMinutes?: number; outcome?: string; notes?: string; nextAction?: string; nextFollowUpAt?: string }>(
    z.object({ leadId: z.string().optional(), durationMinutes: z.coerce.number().min(0).optional(), outcome: z.enum(SALES_CALL_OUTCOMES).optional(), notes: z.string().optional(), nextAction: z.string().optional(), nextFollowUpAt: z.string().optional() }),
    req.body
  );
  const s = ctx(req);
  let phone = '';
  if (b.leadId) {
    const lead = await SalesLead.findOne({ _id: b.leadId, organizationId: orgOf(req) }).select('phone').lean();
    phone = toDialablePhone(lead?.phone)?.e164 || '';
  }
  const minutes = b.durationMinutes || 0;
  const call = await SalesCall.create({
    ...b, leadId: b.leadId || undefined, nextFollowUpAt: b.nextFollowUpAt || undefined, employeeId: s.employeeId,
    outcome: b.outcome || 'connected', organizationId: orgOf(req), createdBy: req.user!.email,
    phone, status: 'completed', channel: 'manual', provider: 'device_sim',
    durationMinutes: minutes, durationSeconds: minutes ? Math.round(minutes * 60) : null,
    durationSource: minutes ? 'crm_timer' : 'unavailable',
  });
  if (b.leadId) await SalesLead.updateOne({ _id: b.leadId, organizationId: orgOf(req) }, { $set: { lastContactedAt: new Date() } });
  if (b.nextFollowUpAt) {
    await SalesFollowUp.create({ organizationId: orgOf(req), leadId: b.leadId || undefined, ownerEmployeeId: s.employeeId, type: 'call', dueAt: new Date(b.nextFollowUpAt), notes: b.nextAction || 'Follow-up from call', createdBy: req.user!.email });
    if (b.leadId) await SalesLead.updateOne({ _id: b.leadId }, { $set: { nextFollowUpAt: new Date(b.nextFollowUpAt) } });
  }
  await logSales(req, 'call_logged', `Call logged (${call.outcome})`, { leadId: call.leadId, metadata: { callId: String(call._id) } });
  res.status(201);
  return call;
}));

salesCrmRoutes.get('/meetings', needModule('comm.meetings') as never, route(async (req) =>
  SalesMeeting.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) }).populate('leadId', 'contactPerson company').sort({ startsAt: -1 }).limit(300).lean()
));

salesCrmRoutes.post('/meetings', needModule('comm.meetings') as never, route(async (req, res) => {
  const b = parseBody<{ title: string; startsAt: string; leadId?: string; type?: string; location?: string; agenda?: string; participants?: string }>(
    z.object({ title: z.string().min(2, 'Title is required'), startsAt: z.string().min(1, 'Date/time is required'), leadId: z.string().optional(), type: z.enum(SALES_MEETING_TYPES).optional(), location: z.string().optional(), agenda: z.string().optional(), participants: z.string().optional() }),
    req.body
  );
  const meeting = await SalesMeeting.create({ ...b, leadId: b.leadId || undefined, startsAt: new Date(b.startsAt), ownerEmployeeId: ctx(req).employeeId, organizationId: orgOf(req), createdBy: req.user!.email });
  await logSales(req, 'meeting_created', `Meeting scheduled: ${meeting.title}`, { leadId: meeting.leadId, metadata: { meetingId: String(meeting._id) } });
  res.status(201);
  return meeting;
}));

salesCrmRoutes.post('/meetings/:id/status', needModule('comm.meetings') as never, route(async (req) => {
  const meeting = await findOwned(SalesMeeting, req, req.params.id as string);
  const b = parseBody<{ status: string; notes?: string; decisions?: string; nextSteps?: string }>(
    z.object({ status: z.enum(SALES_MEETING_STATUSES), notes: z.string().optional(), decisions: z.string().optional(), nextSteps: z.string().optional() }),
    req.body
  );
  Object.assign(meeting, Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
  await meeting.save();
  await logSales(req, 'meeting_updated', `Meeting ${b.status}: ${meeting.title}`, { leadId: meeting.leadId });
  return meeting;
}));

salesCrmRoutes.get('/follow-ups', needModule('comm.followups') as never, route(async (req) => {
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) };
  if (q.status && q.status !== 'all') filter.status = q.status;
  return SalesFollowUp.find(filter).populate('leadId', 'contactPerson company').sort({ dueAt: 1 }).limit(300).lean();
}));

salesCrmRoutes.post('/follow-ups', needModule('comm.followups') as never, route(async (req, res) => {
  const b = parseBody<{ dueAt: string; leadId?: string; type?: string; priority?: string; notes?: string }>(
    z.object({ dueAt: z.string().min(1, 'Due date is required'), leadId: z.string().optional(), type: z.enum(SALES_FOLLOWUP_TYPES).optional(), priority: z.enum(LEAD_PRIORITIES).optional(), notes: z.string().optional() }),
    req.body
  );
  const dueAt = new Date(b.dueAt);
  const followUp = await SalesFollowUp.create({ ...b, leadId: b.leadId || undefined, dueAt, ownerEmployeeId: ctx(req).employeeId, organizationId: orgOf(req), createdBy: req.user!.email });
  if (b.leadId) await SalesLead.updateOne({ _id: b.leadId, organizationId: orgOf(req) }, { $set: { nextFollowUpAt: dueAt } });
  await logSales(req, 'followup_scheduled', 'Follow-up scheduled', { leadId: followUp.leadId, metadata: { followUpId: String(followUp._id) } });
  res.status(201);
  return followUp;
}));

salesCrmRoutes.post('/follow-ups/:id/status', needModule('comm.followups') as never, route(async (req) => {
  const followUp = await findOwned(SalesFollowUp, req, req.params.id as string);
  const status = z.enum(['completed', 'missed', 'cancelled']).parse(req.body?.status);
  followUp.status = status;
  if (status === 'completed') followUp.completedAt = new Date();
  await followUp.save();
  await logSales(req, 'followup_completed', `Follow-up ${status}`, { leadId: followUp.leadId });
  return followUp;
}));

// ---------------------------------------------------------------- email / whatsapp (log + deep-link compose)
salesCrmRoutes.get('/messages', needModule('comm.email_whatsapp') as never, route(async (req) => {
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req, 'employeeId') };
  if (q.channel && ['email', 'whatsapp'].includes(q.channel)) filter.channel = q.channel;
  if (q.leadId && isObjectId(q.leadId)) filter.leadId = oid(q.leadId);
  return SalesMessage.find(filter).populate('leadId', 'contactPerson company email phone').sort({ sentAt: -1 }).limit(300).lean();
}));

salesCrmRoutes.post('/messages', needModule('comm.email_whatsapp') as never, route(async (req, res) => {
  const b = parseBody<{
    channel: 'email' | 'whatsapp';
    body: string;
    toAddress?: string;
    subject?: string;
    leadId?: string;
    dealId?: string;
    direction?: 'outbound' | 'inbound';
  }>(
    z.object({
      channel: z.enum(['email', 'whatsapp']),
      body: z.string().min(1, 'Message body is required'),
      toAddress: z.string().optional(),
      subject: z.string().optional(),
      leadId: z.string().optional(),
      dealId: z.string().optional(),
      direction: z.enum(['outbound', 'inbound']).optional(),
    }),
    req.body
  );
  if (b.leadId && !isObjectId(b.leadId)) throw new ValidationError('Invalid lead');
  if (b.dealId && !isObjectId(b.dealId)) throw new ValidationError('Invalid deal');

  let toAddress = (b.toAddress || '').trim();
  let lead: OsDoc | null = null;
  if (b.leadId) {
    lead = await findOwned(SalesLead, req, b.leadId, 'assignedEmployeeId');
    if (!toAddress) toAddress = b.channel === 'email' ? (lead.email || '') : (lead.phone || '');
  }

  const message = await SalesMessage.create({
    organizationId: orgOf(req),
    channel: b.channel,
    direction: b.direction || 'outbound',
    leadId: b.leadId || undefined,
    dealId: b.dealId || undefined,
    employeeId: ctx(req).employeeId,
    toAddress,
    subject: b.subject || '',
    body: b.body.trim(),
    status: 'logged',
    sentAt: new Date(),
    createdBy: req.user!.email,
    updatedBy: req.user!.email,
  });

  const title = b.channel === 'email' ? `Email logged${b.subject ? `: ${b.subject}` : ''}` : 'WhatsApp message logged';
  await logSales(req, b.channel === 'email' ? 'email_logged' : 'whatsapp_logged', title, {
    leadId: message.leadId,
    dealId: message.dealId,
    detail: b.body.slice(0, 280),
    metadata: { messageId: String(message._id), toAddress, channel: b.channel },
  });

  const deepLink =
    b.channel === 'email'
      ? `mailto:${encodeURIComponent(toAddress)}?subject=${encodeURIComponent(b.subject || '')}&body=${encodeURIComponent(b.body)}`
      : `https://wa.me/${toAddress.replace(/\D/g, '')}?text=${encodeURIComponent(b.body)}`;

  res.status(201);
  return { ...message.toObject(), deepLink };
}));

// ---------------------------------------------------------------- quotations + proposals
const quotationItem = z.object({ name: z.string().min(1), quantity: z.coerce.number().min(0).optional(), price: z.coerce.number().min(0).optional() });
const quotationSchema = z.object({
  customerName: z.string().min(2, 'Customer name is required'),
  dealId: z.string().optional(),
  leadId: z.string().optional(),
  items: z.array(quotationItem).min(1, 'At least one item is required'),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  taxPercent: z.coerce.number().min(0).max(100).optional(),
  validUntil: z.string().optional(),
  terms: z.string().optional(),
  notes: z.string().optional(),
});

function quotationTotals(items: { quantity?: number; price?: number }[], discountPercent = 0, taxPercent = 18) {
  const subtotal = items.reduce((t, i) => t + (i.quantity ?? 1) * (i.price ?? 0), 0);
  const afterDiscount = subtotal * (1 - discountPercent / 100);
  return { subtotal: Math.round(subtotal), total: Math.round(afterDiscount * (1 + taxPercent / 100)) };
}

async function nextQuotationNumber(organizationId: string) {
  const year = new Date().getFullYear();
  const seq = await nextSequence(organizationId, `quotation:${year}`);
  return `QT-${year}-${String(seq).padStart(4, '0')}`;
}

salesCrmRoutes.get('/quotations', needModule('docs.quotations') as never, route(async (req) =>
  SalesQuotation.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) }).sort({ createdAt: -1 }).limit(300).lean()
));

salesCrmRoutes.post('/quotations', needModule('docs.quotations') as never, route(async (req, res) => {
  const b = parseBody<z.infer<typeof quotationSchema>>(quotationSchema, req.body);
  const items = b.items.map((i) => ({ name: i.name, quantity: i.quantity ?? 1, price: i.price ?? 0 }));
  const taxPercent = b.taxPercent ?? 18;
  const discountPercent = b.discountPercent ?? 0;
  const quotation = await SalesQuotation.create({
    ...b, items, taxPercent, discountPercent, ...quotationTotals(items, discountPercent, taxPercent),
    dealId: b.dealId || undefined, leadId: b.leadId || undefined, validUntil: b.validUntil || undefined,
    quotationNumber: await nextQuotationNumber(orgOf(req)), ownerEmployeeId: ctx(req).employeeId, status: 'draft',
    organizationId: orgOf(req), createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  await logSales(req, 'quotation_created', `Quotation ${quotation.quotationNumber} created for ${quotation.customerName}`, { dealId: quotation.dealId });
  res.status(201);
  return quotation;
}));

salesCrmRoutes.get('/quotations/:id', needModule('docs.quotations') as never, route(async (req) => {
  const q = await findOwned(SalesQuotation, req, req.params.id as string);
  const versions = await SalesQuotation.find({ organizationId: orgOf(req), $or: [{ _id: q.previousVersionId }, { previousVersionId: q._id }] }).select('quotationNumber version status createdAt').lean();
  return { quotation: q, versions };
}));

salesCrmRoutes.post('/quotations/:id/status', needModule('docs.quotations') as never, route(async (req) => {
  const q = await findOwned(SalesQuotation, req, req.params.id as string);
  q.status = z.enum(SALES_QUOTATION_STATUSES).parse(req.body?.status);
  q.updatedBy = req.user!.email;
  await q.save();
  await logSales(req, 'quotation_updated', `Quotation ${q.quotationNumber} marked ${q.status}`, { dealId: q.dealId });
  return q;
}));

salesCrmRoutes.post('/quotations/:id/duplicate', needModule('docs.quotations') as never, route(async (req, res) => {
  const original = (await findOwned(SalesQuotation, req, req.params.id as string)).toObject();
  const { _id, createdAt: _c, updatedAt: _u, __v: _v, ...rest } = original;
  void _c; void _u; void _v;
  const copy = await SalesQuotation.create({
    ...rest, quotationNumber: await nextQuotationNumber(orgOf(req)), status: 'draft', version: (original.version || 1) + 1,
    previousVersionId: _id, ownerEmployeeId: ctx(req).employeeId, createdBy: req.user!.email, updatedBy: req.user!.email,
  });
  await logSales(req, 'quotation_created', `Quotation ${copy.quotationNumber} (v${copy.version}) revised from ${original.quotationNumber}`, { dealId: copy.dealId });
  res.status(201);
  return copy;
}));

salesCrmRoutes.get('/proposals', needModule('docs.proposals') as never, route(async (req) =>
  SalesProposal.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) }).populate('dealId', 'dealName').sort({ createdAt: -1 }).limit(300).lean()
));

salesCrmRoutes.post('/proposals', needModule('docs.proposals') as never, route(async (req, res) => {
  const b = parseBody<{ title: string; dealId?: string; scope?: string; pricing?: number; timeline?: string; terms?: string }>(
    z.object({ title: z.string().min(2, 'Title is required'), dealId: z.string().optional(), scope: z.string().optional(), pricing: z.coerce.number().min(0).optional(), timeline: z.string().optional(), terms: z.string().optional() }),
    req.body
  );
  const proposal = await SalesProposal.create({ ...b, dealId: b.dealId || undefined, pricing: b.pricing || 0, ownerEmployeeId: ctx(req).employeeId, status: 'draft', organizationId: orgOf(req), createdBy: req.user!.email, updatedBy: req.user!.email });
  await logSales(req, 'proposal_created', `Proposal created: ${proposal.title}`, { dealId: proposal.dealId });
  res.status(201);
  return proposal;
}));

salesCrmRoutes.post('/proposals/:id/status', needModule('docs.proposals') as never, route(async (req) => {
  const p = await findOwned(SalesProposal, req, req.params.id as string);
  p.status = z.enum(SALES_PROPOSAL_STATUSES).parse(req.body?.status);
  await p.save();
  await logSales(req, 'proposal_updated', `Proposal "${p.title}" marked ${p.status}`, { dealId: p.dealId });
  return p;
}));

// ---------------------------------------------------------------- tasks
salesCrmRoutes.get('/tasks', needModule('tasks.management') as never, route(async (req) => {
  const tasks = await SalesTask.find({ organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) }).sort({ status: 1, dueDate: 1 }).limit(500).lean();
  const now = Date.now();
  const names = await employeeNames(
    orgOf(req),
    await SalesEmployee.find({ organizationId: orgOf(req), _id: { $in: tasks.map((t) => t.ownerEmployeeId).filter(Boolean) } }).lean()
  );
  return tasks.map((t) => ({
    ...t,
    assignedName: names.get(String(t.ownerEmployeeId))?.name || '—',
    status: t.status !== 'completed' && t.dueDate && +new Date(t.dueDate) < now ? 'overdue' : t.status,
  }));
}));

salesCrmRoutes.post('/tasks', needModule('tasks.management') as never, route(async (req, res) => {
  const s = ctx(req);
  const b = parseBody<{ title: string; description?: string; priority?: string; dueDate?: string; employeeId?: string }>(
    z.object({ title: z.string().min(2, 'Title is required'), description: z.string().optional(), priority: z.enum(LEAD_PRIORITIES).optional(), dueDate: z.string().optional(), employeeId: z.string().optional() }),
    req.body
  );
  let owner = s.employeeId;
  let assignee: OsDoc | null = null;
  if (b.employeeId && b.employeeId !== s.employeeId) {
    if (!s.isSalesAdmin) throw new ForbiddenError('Only sales admins can assign tasks to others');
    assignee = await SalesEmployee.findOne({ _id: b.employeeId, organizationId: orgOf(req) }).lean();
    if (!assignee) throw new ValidationError('Choose an employee');
    owner = String(assignee._id);
  }
  const task = await SalesTask.create({ title: b.title, description: b.description || '', priority: b.priority || 'medium', dueDate: b.dueDate || undefined, ownerEmployeeId: owner, status: 'todo', organizationId: orgOf(req), createdBy: req.user!.email });
  if (assignee) {
    await notifyStaff(orgOf(req), {
      type: 'task_assigned',
      title: 'New task assigned',
      body: b.title,
      href: await salesPortalHref(orgOf(req), String(assignee.userId), '/sales-crm/tasks'),
      recipientUserIds: [String(assignee.userId)],
    });
  }
  await logSales(req, 'task_created', assignee ? `Task "${b.title}" assigned` : `Task created: ${b.title}`);
  res.status(201);
  return task;
}));

salesCrmRoutes.post('/tasks/:id/status', needModule('tasks.management') as never, route(async (req) => {
  const t = await findOwned(SalesTask, req, req.params.id as string);
  t.status = z.enum(SALES_TASK_STATUSES).parse(req.body?.status);
  await t.save();
  if (t.status === 'completed') await logSales(req, 'task_completed', `Task completed: ${t.title}`);
  return t;
}));

salesCrmRoutes.get('/calendar', needModule('tasks.calendar') as never, route(async (req) => {
  const q = req.query as Record<string, string>;
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * DAY);
  const to = q.to ? new Date(q.to) : new Date(Date.now() + 35 * DAY);
  const base = { organizationId: orgOf(req), recordStatus: 'active', ...ownScope(req) };
  const [meetings, followUps, tasks] = await Promise.all([
    SalesMeeting.find({ ...base, startsAt: { $gte: from, $lte: to } }).select('title startsAt status type').lean(),
    SalesFollowUp.find({ ...base, dueAt: { $gte: from, $lte: to } }).select('notes dueAt status type').lean(),
    SalesTask.find({ ...base, dueDate: { $gte: from, $lte: to } }).select('title dueDate status').lean(),
  ]);
  return [
    ...meetings.map((m) => ({ id: String(m._id), kind: 'meeting', title: m.title, at: m.startsAt, status: m.status })),
    ...followUps.map((f) => ({ id: String(f._id), kind: 'follow_up', title: f.notes || `Follow-up (${f.type})`, at: f.dueAt, status: f.status })),
    ...tasks.map((t) => ({ id: String(t._id), kind: 'task', title: t.title, at: t.dueDate, status: t.status })),
  ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
}));

// ---------------------------------------------------------------- approvals
salesCrmRoutes.get('/approvals', route(async (req) => {
  const s = ctx(req);
  if (!s.isSalesAdmin && !s.modules['admin.approvals']) throw new ForbiddenError('This module is not enabled for your account');
  const rows = await SalesApproval.find({ organizationId: orgOf(req), ...(s.isSalesAdmin ? {} : { requesterEmployeeId: oid(s.employeeId) }) }).populate('dealId', 'dealName value').sort({ status: 1, createdAt: -1 }).limit(300).lean();
  const employees = await SalesEmployee.find({ organizationId: orgOf(req), _id: { $in: rows.map((r) => r.requesterEmployeeId) } }).lean();
  const names = await employeeNames(orgOf(req), employees);
  return rows.map((r) => ({ ...r, requesterName: names.get(String(r.requesterEmployeeId))?.name || '' }));
}));

salesCrmRoutes.post('/approvals', needModule('admin.approvals') as never, route(async (req, res) => {
  const b = parseBody<{ type: string; dealId?: string; requestedValue?: string; reason?: string }>(
    z.object({ type: z.enum(SALES_APPROVAL_TYPES), dealId: z.string().optional(), requestedValue: z.string().optional(), reason: z.string().optional() }),
    req.body
  );
  const approval = await SalesApproval.create({ ...b, dealId: b.dealId || undefined, requesterEmployeeId: ctx(req).employeeId, status: 'pending', organizationId: orgOf(req), createdBy: req.user!.email });
  await logSales(req, 'approval_requested', `Approval requested (${b.type})`, { dealId: approval.dealId });
  const admins = await SalesEmployee.find({ organizationId: orgOf(req), isSalesAdmin: true, status: 'active' }).select('userId').lean();
  await notifyStaff(orgOf(req), { type: 'sales_approval', title: `Approval requested (${b.type})`, body: b.reason || '', href: '/sales-crm/approvals', recipientUserIds: admins.map((a) => String(a.userId)), emailCategory: 'sales' });
  res.status(201);
  return approval;
}));

salesCrmRoutes.post('/approvals/:id/decide', needAdmin as never, route(async (req) => {
  const b = parseBody<{ decision: 'approved' | 'rejected'; reviewerComment?: string }>(z.object({ decision: z.enum(['approved', 'rejected']), reviewerComment: z.string().optional() }), req.body);
  const approval = await SalesApproval.findOne({ _id: req.params.id, organizationId: orgOf(req) });
  if (!approval) throw new NotFoundError('Approval');
  if (approval.status !== 'pending') throw new ValidationError('This approval was already decided');
  Object.assign(approval, { status: b.decision, reviewerEmployeeId: ctx(req).employeeId, reviewerComment: b.reviewerComment || '', decidedAt: new Date() });
  await approval.save();
  if (b.decision === 'approved' && approval.type === 'discount' && approval.dealId) {
    const value = Number(String(approval.requestedValue).replace(/[^\d.]/g, '')) || 0;
    if (value) await SalesDeal.updateOne({ _id: approval.dealId }, { $set: { discountApproved: value } });
  }
  await writeAudit(actorFrom(req.user!), { entityType: 'SalesApproval', entityId: String(approval._id), field: 'approval_decided', oldValue: 'pending', newValue: b.decision, reason: b.reviewerComment });
  const requester = await SalesEmployee.findById(approval.requesterEmployeeId).select('userId').lean();
  if (requester) {
    await notifyStaff(orgOf(req), {
      type: 'sales_approval',
      title: `Your ${approval.type} request was ${b.decision}`,
      body: b.reviewerComment || '',
      href: await salesPortalHref(orgOf(req), String(requester.userId), '/sales-crm/approvals'),
      recipientUserIds: [String(requester.userId)],
    });
  }
  return approval;
}));

/** Sales person escalates a blocked issue to company / sales admins. */
salesCrmRoutes.post('/escalate', route(async (req) => {
  const s = ctx(req);
  const b = parseBody<{ subject: string; detail?: string }>(
    z.object({ subject: z.string().min(3, 'Subject is required'), detail: z.string().optional() }),
    req.body
  );
  const [salesAdmins, companyAdmins] = await Promise.all([
    SalesEmployee.find({ organizationId: orgOf(req), isSalesAdmin: true, status: 'active', recordStatus: 'active' }).select('userId').lean(),
    User.find({ organizationId: orgOf(req), role: 'admin', isActive: true }).select('_id').lean(),
  ]);
  const recipientUserIds = [...new Set([
    ...salesAdmins.map((a) => String(a.userId)),
    ...companyAdmins.map((a) => String(a._id)),
  ])].filter((id) => id !== req.user!.id);
  if (!recipientUserIds.length) throw new ValidationError('No admin is available to escalate to');
  await notifyStaff(orgOf(req), {
    type: 'sales_escalate',
    title: `Escalation from ${s.name}: ${b.subject}`,
    body: b.detail || 'A sales teammate needs help.',
    href: '/sales-crm/team',
    recipientUserIds,
  });
  await logSales(req, 'escalation', b.subject, { metadata: { detail: b.detail || '' } });
  return { message: 'Sent to your managers. They will follow up in Sales CRM.' };
}));

// ---------------------------------------------------------------- attendance + work status
const todayKey = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

salesCrmRoutes.get('/attendance', route(async (req) => {
  const s = ctx(req);
  const org = orgOf(req);
  if (s.isSalesAdmin) {
    const date = String(req.query.date || todayKey());
    const [employees, records] = await Promise.all([
      SalesEmployee.find({ organizationId: org, status: 'active', recordStatus: 'active' }).lean(),
      SalesAttendance.find({ organizationId: org, date }).lean(),
    ]);
    const names = await employeeNames(org, employees);
    return {
      date,
      rows: employees.map((e) => {
        const r = records.find((x) => String(x.employeeId) === String(e._id));
        return { employeeId: String(e._id), name: names.get(String(e._id))?.name, employeeCode: e.employeeCode, status: r?.status || 'absent', checkInAt: r?.checkInAt, checkOutAt: r?.checkOutAt };
      }),
      present: records.filter((r) => r.checkInAt).length,
      total: employees.length,
    };
  }
  if (!s.modules['workforce.attendance_sync']) throw new ForbiddenError('This module is not enabled for your account');
  const history = await SalesAttendance.find({ organizationId: org, employeeId: s.employeeId }).sort({ date: -1 }).limit(60).lean();
  return { today: history.find((h) => h.date === todayKey()) || null, history };
}));

salesCrmRoutes.post('/attendance/check-in', needModule('workforce.attendance_sync') as never, route(async (req) => {
  const s = ctx(req);
  const date = todayKey();
  const existing = await SalesAttendance.findOne({ organizationId: orgOf(req), employeeId: s.employeeId, date }).lean();
  if (existing?.checkInAt) throw new ValidationError('Already checked in today.');
  const row = await SalesAttendance.findOneAndUpdate(
    { organizationId: orgOf(req), employeeId: s.employeeId, date },
    { $set: { checkInAt: new Date(), status: 'present' }, $setOnInsert: { createdBy: req.user!.email } },
    { upsert: true, new: true }
  );
  await logSales(req, 'attendance_check_in', 'Checked in for the day');
  return row;
}));

salesCrmRoutes.post('/attendance/check-out', needModule('workforce.attendance_sync') as never, route(async (req) => {
  const s = ctx(req);
  const row = await SalesAttendance.findOne({ organizationId: orgOf(req), employeeId: s.employeeId, date: todayKey() });
  if (!row?.checkInAt) throw new ValidationError('Check in first.');
  if (row.checkOutAt) throw new ValidationError('Already checked out today.');
  row.checkOutAt = new Date();
  await row.save();
  return row;
}));

salesCrmRoutes.get('/work-status', route(async (req) => {
  const s = ctx(req);
  return SalesWorkStatus.find({ organizationId: orgOf(req), ...(s.isSalesAdmin ? {} : { employeeId: oid(s.employeeId) }) }).sort({ date: -1 }).limit(100).lean();
}));

salesCrmRoutes.post('/work-status', needModule('perf.daily_work_status') as never, route(async (req) => {
  const b = parseBody<{ summary: string; blockers?: string; planTomorrow?: string }>(
    z.object({ summary: z.string().min(2, 'Add a short remark'), blockers: z.string().optional(), planTomorrow: z.string().optional() }),
    req.body
  );
  const s = ctx(req);
  const row = await SalesWorkStatus.findOneAndUpdate(
    { organizationId: orgOf(req), employeeId: s.employeeId, date: todayKey() },
    { $set: { ...b, updatedBy: req.user!.email }, $setOnInsert: { createdBy: req.user!.email } },
    { upsert: true, new: true }
  );
  await logSales(req, 'daily_work_status', 'Daily work status submitted', { detail: b.summary });
  return row;
}));

// ---------------------------------------------------------------- targets + territories
salesCrmRoutes.get('/targets', route(async (req) => {
  const s = ctx(req);
  const org = orgOf(req);
  const targets = await SalesTarget.find({ organizationId: org, recordStatus: 'active', ...(s.isSalesAdmin ? {} : { employeeId: oid(s.employeeId) }) }).sort({ periodStart: -1 }).lean();
  if (!targets.length) return [];
  const minStart = new Date(Math.min(...targets.map((t) => +t.periodStart)));
  const maxEnd = new Date(Math.max(...targets.map((t) => +t.periodEnd + DAY)));
  const deals = await SalesDeal.find({ organizationId: org, recordStatus: 'active', stage: 'won', closedAt: { $gte: minStart, $lt: maxEnd } }).select('ownerEmployeeId value finalOffer closedAt').lean();
  const employees = await SalesEmployee.find({ organizationId: org, _id: { $in: targets.map((t) => t.employeeId) } }).lean();
  const names = await employeeNames(org, employees);
  const now = Date.now();
  return targets.map((t) => {
    // The end date is inclusive: a deal closed any time on the last day counts.
    const endExclusive = +t.periodEnd + DAY;
    const actual = deals.filter((d) => String(d.ownerEmployeeId) === String(t.employeeId) && +d.closedAt >= +t.periodStart && +d.closedAt < endExclusive).reduce((sum, d) => sum + revenueOf(d), 0);
    return {
      ...t, employeeName: names.get(String(t.employeeId))?.name || '', actual,
      pct: t.targetValue > 0 ? Math.round((actual / t.targetValue) * 100) : 0,
      remaining: Math.max(0, t.targetValue - actual),
      daysRemaining: Math.max(0, Math.ceil((endExclusive - now) / DAY)),
    };
  });
}));

salesCrmRoutes.post('/targets', needAdmin as never, route(async (req, res) => {
  const b = parseBody<{ employeeId: string; period: string; periodStart: string; periodEnd: string; targetValue: number }>(
    z.object({ employeeId: z.string().min(1, 'Choose an employee'), period: z.enum(SALES_TARGET_PERIODS), periodStart: z.string().min(1), periodEnd: z.string().min(1), targetValue: z.coerce.number().positive('Target must be greater than 0') }),
    req.body
  );
  if (new Date(b.periodEnd) < new Date(b.periodStart)) throw new ValidationError('End date must be after the start date');
  if (!(await SalesEmployee.exists({ _id: b.employeeId, organizationId: orgOf(req) }))) throw new ValidationError('Choose an employee');
  const target = await SalesTarget.create({ ...b, periodStart: new Date(b.periodStart), periodEnd: new Date(b.periodEnd), organizationId: orgOf(req), createdBy: req.user!.email });
  res.status(201);
  return target;
}));

salesCrmRoutes.delete('/targets/:id', needAdmin as never, route(async (req) => {
  const t = await SalesTarget.findOneAndDelete({ _id: req.params.id, organizationId: orgOf(req) });
  if (!t) throw new NotFoundError('Target');
  return { id: String(t._id) };
}));

salesCrmRoutes.get('/territories', route(async (req) => SalesTerritory.find({ organizationId: orgOf(req), recordStatus: 'active' }).sort({ name: 1 }).lean()));

salesCrmRoutes.post('/territories', needAdmin as never, route(async (req, res) => {
  const b = parseBody<{ name: string; type?: string; description?: string }>(z.object({ name: z.string().min(2, 'Name is required'), type: z.enum(SALES_TERRITORY_TYPES).optional(), description: z.string().optional() }), req.body);
  if (await SalesTerritory.exists({ organizationId: orgOf(req), name: b.name.trim() })) throw new ConflictError('A territory with this name already exists');
  const t = await SalesTerritory.create({ ...b, name: b.name.trim(), type: b.type || 'custom', organizationId: orgOf(req), createdBy: req.user!.email });
  res.status(201);
  return t;
}));

salesCrmRoutes.delete('/territories/:id', needAdmin as never, route(async (req) => {
  const t = await SalesTerritory.findOneAndDelete({ _id: req.params.id, organizationId: orgOf(req) });
  if (!t) throw new NotFoundError('Territory');
  return { id: String(t._id) };
}));

// ---------------------------------------------------------------- activity, performance, analytics
salesCrmRoutes.get('/activity', route(async (req) => {
  const s = ctx(req);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { organizationId: oid(orgOf(req)) };
  if (!s.isSalesAdmin) filter.actorEmployeeId = oid(s.employeeId);
  else if (q.employeeId && isObjectId(q.employeeId)) filter.actorEmployeeId = oid(q.employeeId);
  if (q.type) filter.type = q.type;
  return SalesActivityEvent.find(filter).sort({ createdAt: -1 }).limit(Math.min(300, Number(q.limit) || 100)).lean();
}));

salesCrmRoutes.get('/performance', route(async (req) => {
  const s = ctx(req);
  const org = oid(orgOf(req));
  const employeeId = s.isSalesAdmin && isObjectId(req.query.employeeId) ? oid(String(req.query.employeeId)) : oid(s.employeeId);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(+todayStart + DAY);
  const weekStart = new Date(+todayStart - todayStart.getDay() * DAY);
  const [deals, calls, meetings, proposals, quotations, followUps, tasks, leadsToday] = await Promise.all([
    SalesDeal.find({ organizationId: org, recordStatus: 'active', ownerEmployeeId: employeeId }).select('stage value probability finalOffer closedAt expectedCloseDate').lean(),
    SalesCall.find({ organizationId: org, employeeId }).select('calledAt').lean(),
    SalesMeeting.find({ organizationId: org, ownerEmployeeId: employeeId }).select('startsAt status').lean(),
    SalesProposal.find({ organizationId: org, ownerEmployeeId: employeeId }).select('createdAt').lean(),
    SalesQuotation.find({ organizationId: org, ownerEmployeeId: employeeId }).select('createdAt').lean(),
    SalesFollowUp.find({ organizationId: org, ownerEmployeeId: employeeId, recordStatus: 'active' }).select('status dueAt completedAt').lean(),
    SalesTask.find({ organizationId: org, ownerEmployeeId: employeeId, recordStatus: 'active' }).select('status dueDate createdAt').lean(),
    SalesLead.countDocuments({ organizationId: org, assignedEmployeeId: employeeId, createdAt: { $gte: todayStart, $lt: todayEnd } }),
  ]);
  const won = deals.filter((d) => d.stage === 'won');
  const lost = deals.filter((d) => d.stage === 'lost');
  const revenue = won.reduce((t, d) => t + revenueOf(d), 0);
  const inToday = (d?: Date) => Boolean(d && d >= todayStart && d < todayEnd);
  const openDeals = deals.filter((d) => !['won', 'lost'].includes(d.stage));
  const months = Array.from({ length: 6 }, (_, i) => {
    const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const value = openDeals.filter((d) => d.expectedCloseDate && new Date(d.expectedCloseDate).toISOString().slice(0, 7) === key).reduce((t, d) => t + ((d.value || 0) * (d.probability || 0)) / 100, 0);
    return { month: key, weighted: Math.round(value) };
  });
  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const completedFollowUps = followUps.filter((f) => f.status === 'completed').length;
  const assigned = tasks.length + followUps.length;
  return {
    performance: {
      revenue, won: won.length, lost: lost.length, conversionRate: deals.length ? Math.round((won.length / deals.length) * 100) : 0,
      avgDeal: won.length ? Math.round(revenue / won.length) : 0, calls: calls.length, meetings: meetings.length, proposals: proposals.length, followUpsCompleted: completedFollowUps,
    },
    daily: {
      leadsReceived: leadsToday, calls: calls.filter((c) => inToday(c.calledAt)).length,
      meetingsHeld: meetings.filter((m) => m.status === 'completed' && inToday(m.startsAt)).length,
      followUpsDone: followUps.filter((f) => inToday(f.completedAt)).length,
      proposals: proposals.filter((p) => inToday(p.createdAt)).length, quotations: quotations.filter((q) => inToday(q.createdAt)).length,
      won: won.filter((d) => inToday(d.closedAt)).length, lost: lost.filter((d) => inToday(d.closedAt)).length,
      revenueToday: won.filter((d) => inToday(d.closedAt)).reduce((t, d) => t + revenueOf(d), 0),
      pendingWork: followUps.filter((f) => f.status === 'pending').length,
    },
    forecast: {
      openPipeline: openDeals.reduce((t, d) => t + (d.value || 0), 0),
      weightedPipeline: Math.round(openDeals.reduce((t, d) => t + ((d.value || 0) * (d.probability || 0)) / 100, 0)),
      openDeals: openDeals.length, months,
      byStage: SALES_DEAL_STAGES.filter((st) => !['won', 'lost'].includes(st)).map((st) => ({ stage: st, weighted: Math.round(openDeals.filter((d) => d.stage === st).reduce((t, d) => t + ((d.value || 0) * (d.probability || 0)) / 100, 0)) })),
    },
    productivity: {
      assigned, completed: completedTasks + completedFollowUps,
      completionPct: assigned ? Math.round(((completedTasks + completedFollowUps) / assigned) * 100) : 0,
      pending: assigned - completedTasks - completedFollowUps,
      overdueTasks: tasks.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < now).length,
      overdueFollowUps: followUps.filter((f) => f.status === 'pending' && f.dueAt < now).length,
      weeklyTasks: tasks.filter((t) => t.createdAt >= weekStart).length,
    },
  };
}));

salesCrmRoutes.get('/leaderboard', route(async (req) => {
  const s = ctx(req);
  if (!s.isSalesAdmin && !s.modules['perf.leaderboard']) throw new ForbiddenError('This module is not enabled for your account');
  const org = orgOf(req);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [employees, deals] = await Promise.all([
    SalesEmployee.find({ organizationId: org, status: 'active', isSalesAdmin: false, recordStatus: 'active' }).lean(),
    SalesDeal.find({ organizationId: org, recordStatus: 'active', stage: 'won', closedAt: { $gte: monthStart } }).select('ownerEmployeeId value finalOffer').lean(),
  ]);
  const names = await employeeNames(org, employees);
  return employees
    .map((e) => {
      const mine = deals.filter((d) => String(d.ownerEmployeeId) === String(e._id));
      return { employeeId: String(e._id), name: names.get(String(e._id))?.name, revenue: mine.reduce((t, d) => t + revenueOf(d), 0), dealsWon: mine.length, me: String(e._id) === s.employeeId };
    })
    .sort((a, b) => b.revenue - a.revenue);
}));

salesCrmRoutes.get('/analytics', needAdmin as never, route(async (req) => {
  const org = oid(orgOf(req));
  const [deals, leads] = await Promise.all([
    SalesDeal.find({ organizationId: org, recordStatus: 'active' }).select('stage value finalOffer closedAt lostReason ownerEmployeeId createdAt').lean(),
    SalesLead.find({ organizationId: org, recordStatus: 'active' }).select('status source createdAt').lean(),
  ]);
  const won = deals.filter((d) => d.stage === 'won');
  const lost = deals.filter((d) => d.stage === 'lost');
  const now = new Date();
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    return { month: key, revenue: won.filter((d) => d.closedAt && new Date(d.closedAt).toISOString().slice(0, 7) === key).reduce((t, d) => t + revenueOf(d), 0) };
  });
  const sources = SALES_LEAD_SOURCES.map((src) => {
    const rows = leads.filter((l) => l.source === src);
    const converted = rows.filter((l) => l.status === 'converted').length;
    return { source: src, leads: rows.length, converted, rate: rows.length ? Math.round((converted / rows.length) * 100) : 0 };
  }).filter((r) => r.leads > 0);
  return {
    revenue: { total: won.reduce((t, d) => t + revenueOf(d), 0), monthly, avgDeal: won.length ? Math.round(won.reduce((t, d) => t + revenueOf(d), 0) / won.length) : 0 },
    conversion: {
      leads: leads.length, converted: leads.filter((l) => l.status === 'converted').length,
      leadRate: leads.length ? Math.round((leads.filter((l) => l.status === 'converted').length / leads.length) * 100) : 0,
      won: won.length, lost: lost.length, winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0,
      byStage: SALES_DEAL_STAGES.map((st) => ({ stage: st, count: deals.filter((d) => d.stage === st).length })),
    },
    sources,
    lostDeals: {
      total: lost.length, value: lost.reduce((t, d) => t + (d.value || 0), 0),
      reasons: SALES_LOST_REASONS.map((r) => ({ reason: r, count: lost.filter((d) => (d.lostReason || 'other') === r).length })).filter((r) => r.count > 0),
    },
  };
}));
