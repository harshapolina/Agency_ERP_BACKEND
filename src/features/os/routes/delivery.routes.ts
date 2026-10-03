import { z } from 'zod';
import type { Model } from 'mongoose';
import {
  Project, Task, Milestone, ProjectMember, ProjectUpdate, TaskComment, TaskDependency, TaskWorkSession,
  Meeting, OsDocument, Conversion, Vendor, Invoice, ActivityEvent, User,
} from '../../../models/index.js';
import { authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, parseBody, oid, isObjectId, type CrudContext } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity, notifyStaff, writeAudit, type Actor } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/index.js';
import { permissionsAllow } from '../../../shared/types/index.js';
import {
  DEFAULT_PROJECT_MILESTONES, MILESTONE_STATUSES, PROJECT_STATUSES, PROJECT_PRIORITIES, TASK_STATUSES,
  TASK_PRIORITIES, MEETING_TYPES, VISIBILITY_LEVELS, normalizeProjectStatus,
} from '../../../shared/constants/os.js';
import { withDisplayStatus } from '../../../shared/os/money.js';
import type { OsDoc } from '../../../models/os/base.js';
import { syncAgencyTaskToSalesPortal } from '../services/sales-task.service.js';

const asOs = (m: unknown) => m as Model<OsDoc>;

const manageAll = (perms: string[]) => permissionsAllow(perms, '*') || permissionsAllow(perms, 'projects:write');

async function scopedProjectIds(ctx: CrudContext) {
  const uid = ctx.actor.userId!;
  const [memberRows, pocRows] = await Promise.all([
    ProjectMember.find({ organizationId: ctx.organizationId, userId: uid }).select('projectId').lean(),
    Project.find({ organizationId: ctx.organizationId, primaryPocUserId: uid }).select('_id').lean(),
  ]);
  return [...memberRows.map((m) => m.projectId), ...pocRows.map((p) => p._id)];
}

async function ensureMember(organizationId: string, projectId: unknown, userId: unknown, createdBy: string, role = 'member') {
  if (!userId) return;
  await ProjectMember.updateOne(
    { organizationId, projectId, userId },
    { $setOnInsert: { organizationId, projectId, userId, roleOnProject: role, createdBy } },
    { upsert: true }
  );
}

async function syncProjectProgress(projectId: unknown) {
  const milestones = await Milestone.find({ projectId, recordStatus: 'active' }).lean();
  if (!milestones.length) return null;
  const total = milestones.reduce((s, m) => s + (m.weight || 1), 0);
  const done = milestones.filter((m) => m.status === 'completed').reduce((s, m) => s + (m.weight || 1), 0);
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  await Project.updateOne({ _id: projectId }, { $set: { progress } });
  return progress;
}

async function seedMilestones(actor: Actor, project: OsDoc) {
  const existing = await Milestone.countDocuments({ projectId: project._id, recordStatus: 'active' });
  if (existing) throw new ValidationError('Project already has milestones');
  await Milestone.insertMany(
    DEFAULT_PROJECT_MILESTONES.map((name, i) => ({
      organizationId: actor.organizationId, projectId: project._id, conversionUuid: project.conversionUuid || '',
      name, sortOrder: i, weight: 1, status: 'pending', visibleToClient: true, createdBy: actor.email, updatedBy: actor.email,
    }))
  );
  await syncProjectProgress(project._id);
}

async function loadProjectFor(ctx: CrudContext, id: string) {
  if (!isObjectId(id)) throw new NotFoundError('Project');
  const project = await Project.findOne({ _id: id, organizationId: ctx.organizationId }).lean();
  if (!project) throw new NotFoundError('Project');
  if (!manageAll(ctx.req.user!.permissions)) {
    const ids = (await scopedProjectIds(ctx)).map(String);
    if (!ids.includes(String(project._id))) throw new NotFoundError('Project');
  }
  return project as OsDoc;
}

const ctxOf = (req: CrudContext['req']): CrudContext => ({ req, actor: actorFrom(req.user!), organizationId: req.user!.organizationId });

// ---------------------------------------------------------------- projects
const projectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  conversionUuid: z.string().optional(),
  service: z.string().optional(),
  description: z.string().optional(),
  startDate: z.string().optional(),
  expectedDelivery: z.string().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  budget: z.coerce.number().min(0).optional(),
  primaryPocUserId: z.string().optional(),
  seedMilestones: z.boolean().optional(),
});

export const projectRoutes = crudRouter({
  model: asOs(Project),
  resource: 'projects',
  entityType: 'project',
  label: 'Project',
  actorAsUserId: true,
  searchFields: ['name', 'description', 'service'],
  filterFields: ['status', 'priority', 'vendorId', 'conversionUuid', 'primaryPocUserId'],
  populate: [{ path: 'vendorId', select: 'companyName' }, { path: 'primaryPocUserId', select: 'firstName lastName email' }],
  createSchema: projectSchema,
  updateSchema: projectSchema.partial(),
  scope: async (ctx) => (manageAll(ctx.req.user!.permissions) ? {} : { _id: { $in: await scopedProjectIds(ctx) } }),
  transform: (d) => ({ ...d, status: normalizeProjectStatus(d.status) }),
  prepare: async (data, ctx, existing) => {
    const { seedMilestones: _seed, ...rest } = data as Record<string, unknown>;
    void _seed;
    if (rest.conversionUuid && rest.conversionUuid !== existing?.conversionUuid) {
      const conversion = await Conversion.findOne({ organizationId: ctx.organizationId, conversionUuid: rest.conversionUuid }).lean();
      if (!conversion) throw new ValidationError('Client conversion not found');
      rest.conversionId = conversion._id;
      rest.vendorId = conversion.vendorId;
    }
    if (rest.status === 'completed' && existing?.status !== 'completed') rest.actualCompletion = new Date();
    return rest;
  },
  afterCreate: async (doc, ctx) => {
    if (doc.primaryPocUserId) await ensureMember(ctx.organizationId, doc._id, doc.primaryPocUserId, ctx.actor.email, 'poc');
    await ensureMember(ctx.organizationId, doc._id, ctx.actor.userId, ctx.actor.email);
    if (ctx.req.body?.seedMilestones) await seedMilestones(ctx.actor, doc);
    await logActivity(ctx.actor, { title: 'Project created', detail: doc.name, entityType: 'project', entityId: String(doc._id), projectId: String(doc._id), conversionUuid: doc.conversionUuid, actionType: 'PROJECT_CREATED' });
  },
  afterUpdate: async (doc, prev, ctx) => {
    if (String(doc.primaryPocUserId || '') !== String(prev.primaryPocUserId || '')) {
      await ensureMember(ctx.organizationId, doc._id, doc.primaryPocUserId, ctx.actor.email, 'poc');
      await logActivity(ctx.actor, { title: 'Project POC changed', detail: doc.name, entityType: 'project', entityId: String(doc._id), projectId: String(doc._id), actionType: 'PROJECT_POC_CHANGED' });
      if (doc.primaryPocUserId) await notifyStaff(ctx.organizationId, { title: `You are now POC for ${doc.name}`, href: `/projects/${doc._id}`, recipientUserIds: [String(doc.primaryPocUserId)], excludeUserId: ctx.actor.userId });
    }
    if (normalizeProjectStatus(doc.status) !== normalizeProjectStatus(prev.status)) {
      await writeAudit(ctx.actor, { entityType: 'project', entityId: String(doc._id), conversionUuid: doc.conversionUuid, field: 'status', oldValue: prev.status, newValue: doc.status, reason: 'Status updated' });
    }
  },
  extend: (router) => {
    router.get(
      '/:id/workspace',
      authorize('projects:read'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const org = oid(ctx.organizationId);
        const [vendor, conversion, milestones, members, updates, tasks, meetings, documents, invoices, activity] = await Promise.all([
          project.vendorId ? Vendor.findById(project.vendorId).lean() : null,
          project.conversionUuid ? Conversion.findOne({ organizationId: org, conversionUuid: project.conversionUuid }).select('publicCode conversionUuid').lean() : null,
          Milestone.find({ organizationId: org, projectId: project._id, recordStatus: 'active' }).sort({ sortOrder: 1 }).lean(),
          ProjectMember.find({ organizationId: org, projectId: project._id }).populate('userId', 'firstName lastName email role').lean(),
          ProjectUpdate.find({ organizationId: org, projectId: project._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
          Task.find({ organizationId: org, projectId: project._id, recordStatus: { $ne: 'archived' } }).populate('assignedTo', 'firstName lastName').sort({ dueDate: 1, createdAt: -1 }).lean(),
          Meeting.find({ organizationId: org, projectId: project._id, recordStatus: 'active' }).sort({ startsAt: -1 }).lean(),
          OsDocument.find({ organizationId: org, projectId: project._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
          Invoice.find({ organizationId: org, projectId: project._id, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
          ActivityEvent.find({ organizationId: org, projectId: project._id }).sort({ createdAt: -1 }).limit(40).lean(),
        ]);
        const invoiceRows = invoices.map((i) => withDisplayStatus(i));
        const nonCancelled = invoiceRows.filter((i) => i.status !== 'cancelled');
        const invoiced = nonCancelled.filter((i) => i.status !== 'draft').reduce((s, i) => s + (i.total || 0), 0);
        const received = nonCancelled.reduce((s, i) => s + (i.amountPaid || 0), 0);
        const poc = project.primaryPocUserId ? await User.findById(project.primaryPocUserId).select('firstName lastName email').lean() : null;
        return {
          project: { ...project, status: normalizeProjectStatus(project.status) },
          poc, vendor, conversion, milestones, members, updates, tasks, meetings, documents, activity,
          invoices: invoiceRows,
          rollup: { contract: project.budget || 0, invoiced, received, outstanding: Math.max(0, invoiced - received) },
        };
      })
    );

    router.post(
      '/:id/milestones/seed',
      authorize('milestones:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        await seedMilestones(ctx.actor, project);
        return Milestone.find({ projectId: project._id, recordStatus: 'active' }).sort({ sortOrder: 1 }).lean();
      })
    );

    router.post(
      '/:id/milestones',
      authorize('milestones:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const body = parseBody<{ name: string; description?: string; weight?: number; dueDate?: string; visibleToClient?: boolean }>(
          z.object({ name: z.string().min(1), description: z.string().optional(), weight: z.coerce.number().optional(), dueDate: z.string().optional(), visibleToClient: z.boolean().optional() }),
          req.body
        );
        const last = await Milestone.findOne({ projectId: project._id, recordStatus: 'active' }).sort({ sortOrder: -1 }).lean();
        const milestone = await Milestone.create({
          organizationId: ctx.organizationId, projectId: project._id, conversionUuid: project.conversionUuid || '',
          name: body.name, description: body.description || '', weight: Math.max(0.1, body.weight || 1),
          dueDate: body.dueDate || undefined, visibleToClient: body.visibleToClient ?? true,
          sortOrder: last ? last.sortOrder + 1 : 0, createdBy: ctx.actor.email, updatedBy: ctx.actor.email,
        });
        await syncProjectProgress(project._id);
        await logActivity(ctx.actor, { title: 'Milestone added', detail: `${body.name} · ${project.name}`, entityType: 'milestone', entityId: String(milestone._id), projectId: String(project._id) });
        return milestone;
      })
    );

    router.patch(
      '/:id/milestones/:milestoneId',
      authorize('milestones:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const body = parseBody<{ status?: string; name?: string; description?: string; weight?: number; dueDate?: string; visibleToClient?: boolean }>(
          z.object({ status: z.enum(MILESTONE_STATUSES).optional(), name: z.string().min(1).optional(), description: z.string().optional(), weight: z.coerce.number().optional(), dueDate: z.string().optional(), visibleToClient: z.boolean().optional() }),
          req.body
        );
        const milestone = await Milestone.findOne({ _id: req.params.milestoneId, projectId: project._id });
        if (!milestone) throw new NotFoundError('Milestone');
        const prev = milestone.status;
        if (body.status) {
          milestone.status = body.status;
          milestone.completedAt = body.status === 'completed' ? new Date() : undefined;
        }
        if (body.name) milestone.name = body.name;
        if (body.description !== undefined) milestone.description = body.description;
        if (body.weight !== undefined) milestone.weight = Math.max(0.1, body.weight || 1);
        if (body.dueDate !== undefined) milestone.dueDate = body.dueDate || undefined;
        if (body.visibleToClient !== undefined) milestone.visibleToClient = body.visibleToClient;
        milestone.updatedBy = ctx.actor.email;
        await milestone.save();
        const progress = await syncProjectProgress(project._id);
        if (body.status && body.status !== prev) {
          await logActivity(ctx.actor, {
            title: body.status === 'completed' ? 'Milestone completed' : 'Milestone status changed',
            detail: `${milestone.name}: ${prev} → ${body.status} · project ${progress ?? 0}%`,
            entityType: 'milestone', entityId: String(milestone._id), projectId: String(project._id), conversionUuid: project.conversionUuid,
          });
        }
        return { milestone, progress };
      })
    );

    router.delete(
      '/:id/milestones/:milestoneId',
      authorize('milestones:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        await Milestone.updateOne({ _id: req.params.milestoneId, projectId: project._id }, { $set: { recordStatus: 'archived', updatedBy: ctx.actor.email } });
        return { progress: await syncProjectProgress(project._id) };
      })
    );

    router.post(
      '/:id/members',
      authorize('projects:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const userId = String(req.body?.userId || '');
        const user = isObjectId(userId) ? await User.findOne({ _id: userId, organizationId: ctx.organizationId, isActive: true }).lean() : null;
        if (!user) throw new ValidationError('Select an active team member');
        await ensureMember(ctx.organizationId, project._id, user._id, ctx.actor.email);
        await logActivity(ctx.actor, { title: 'Project member added', detail: `${user.firstName} ${user.lastName} · ${project.name}`, entityType: 'project', entityId: String(project._id), projectId: String(project._id), actionType: 'PROJECT_MEMBER_ADDED' });
        await notifyStaff(ctx.organizationId, { title: `Added to project ${project.name}`, href: `/projects/${project._id}`, recipientUserIds: [userId], excludeUserId: ctx.actor.userId });
        return ProjectMember.find({ projectId: project._id }).populate('userId', 'firstName lastName email role').lean();
      })
    );

    router.delete(
      '/:id/members/:userId',
      authorize('projects:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        if (String(project.primaryPocUserId || '') === req.params.userId) throw new ValidationError('Change the POC before removing them');
        await ProjectMember.deleteOne({ organizationId: ctx.organizationId, projectId: project._id, userId: req.params.userId });
        await logActivity(ctx.actor, { title: 'Project member removed', detail: project.name, entityType: 'project', entityId: String(project._id), projectId: String(project._id), actionType: 'PROJECT_MEMBER_REMOVED' });
        return { removed: true };
      })
    );

    router.post(
      '/:id/updates',
      authorize('project_updates:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const body = parseBody<{ title: string; body?: string; visibility?: string }>(
          z.object({ title: z.string().min(1), body: z.string().optional(), visibility: z.enum(VISIBILITY_LEVELS).optional() }),
          req.body
        );
        const visibility = body.visibility || 'internal';
        const update = await ProjectUpdate.create({
          organizationId: ctx.organizationId, projectId: project._id, conversionUuid: project.conversionUuid || '',
          title: body.title, body: body.body || '', visibility,
          publishedAt: visibility === 'client_visible' ? new Date() : undefined,
          createdBy: ctx.actor.email, updatedBy: ctx.actor.email,
        });
        await logActivity(ctx.actor, { title: 'Project update posted', detail: body.title, entityType: 'project_update', entityId: String(update._id), projectId: String(project._id), conversionUuid: project.conversionUuid });
        return update;
      })
    );

    router.patch(
      '/:id/updates/:updateId',
      authorize('project_updates:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const project = await loadProjectFor(ctx, req.params.id as string);
        const visibility = req.body?.visibility as string;
        if (!(VISIBILITY_LEVELS as readonly string[]).includes(visibility)) throw new ValidationError('Invalid visibility');
        const update = await ProjectUpdate.findOne({ _id: req.params.updateId, projectId: project._id });
        if (!update) throw new NotFoundError('Update');
        update.visibility = visibility;
        if (visibility === 'client_visible' && !update.publishedAt) update.publishedAt = new Date();
        await update.save();
        return update;
      })
    );
  },
});

// ---------------------------------------------------------------- tasks
const taskSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  projectId: z.string().optional(),
  assignedTo: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: z.string().optional(),
  startDate: z.string().optional(),
  ownerSide: z.enum(['editco', 'client']).optional(),
  visibleToClient: z.boolean().optional(),
  clientActionRequired: z.boolean().optional(),
  estimatedHours: z.coerce.number().optional(),
  leadId: z.string().optional(),
});

async function resolveAssignee(ctx: CrudContext, assignedTo: string | undefined, projectId: string | undefined) {
  if (!assignedTo) return;
  const user = isObjectId(assignedTo) ? await User.findOne({ _id: assignedTo, organizationId: ctx.organizationId, isActive: true }).lean() : null;
  if (!user) throw new ValidationError('Assignee must be an active team member');
  if (projectId) {
    const project = await Project.findById(projectId).select('primaryPocUserId').lean();
    const member = await ProjectMember.exists({ projectId, userId: assignedTo });
    if (!member && String(project?.primaryPocUserId || '') !== assignedTo) throw new ValidationError('Assignee must be a project member');
  }
}

async function incompleteBlockers(taskId: unknown) {
  const deps = await TaskDependency.find({ taskId }).lean();
  if (!deps.length) return [];
  return Task.find({ _id: { $in: deps.map((d) => d.dependsOnTaskId) }, recordStatus: { $ne: 'archived' }, status: { $ne: 'completed' } }).select('title').lean();
}

async function closeOpenSession(taskId: unknown) {
  const open = await TaskWorkSession.findOne({ taskId, endedAt: { $exists: false } });
  if (!open) return;
  open.endedAt = new Date();
  open.durationMs = open.endedAt.getTime() - open.startedAt.getTime();
  await open.save();
}

async function notifyUnblocked(actor: Actor, task: OsDoc) {
  const dependents = await TaskDependency.find({ dependsOnTaskId: task._id }).lean();
  if (!dependents.length) return;
  const tasks = await Task.find({ _id: { $in: dependents.map((d) => d.taskId) }, assignedTo: { $exists: true } }).lean();
  for (const t of tasks) {
    await notifyStaff(actor.organizationId, { title: `Unblocked: ${t.title}`, body: `Dependency "${task.title}" was completed`, href: `/tasks/${t._id}`, recipientUserIds: [String(t.assignedTo)] });
  }
}

async function transitionTask(ctx: CrudContext, task: OsDoc, next: string, overrideDeps = false) {
  const prev = task.status === 'pending' ? 'todo' : task.status;
  if (prev === next) return task;
  if (prev === 'completed') throw new ValidationError('Completed tasks cannot be reopened');
  if (prev === 'cancelled' && next !== 'todo') throw new ValidationError('Cancelled tasks can only move back to To do');
  if (next === 'in_progress') {
    const blockers = await incompleteBlockers(task._id);
    if (blockers.length && !overrideDeps) throw new ValidationError(`Blocked by incomplete dependencies: ${blockers.map((b) => b.title).join(', ')}`);
    if (blockers.length) await logActivity(ctx.actor, { title: 'Dependency override', detail: task.title, entityType: 'task', entityId: String(task._id), projectId: task.projectId ? String(task.projectId) : undefined, actionType: 'TASK_STARTED', metadata: { override: true, blockers: blockers.map((b) => String(b._id)) } });
  }
  const set: Record<string, unknown> = { status: next };
  if (next === 'completed') {
    await closeOpenSession(task._id);
    Object.assign(set, { completedAt: new Date(), actualEndTime: new Date() });
  }
  if (next === 'in_progress' && !task.actualStartTime) set.actualStartTime = new Date();
  const updated = (await Task.findByIdAndUpdate(task._id, { $set: set }, { new: true }).lean()) as OsDoc;
  await logActivity(ctx.actor, { title: next === 'completed' ? 'Task completed' : 'Task status changed', detail: `${task.title}: ${prev} → ${next}`, entityType: 'task', entityId: String(task._id), projectId: task.projectId ? String(task.projectId) : undefined, actionType: next === 'completed' ? 'TASK_COMPLETED' : 'TASK_STATUS_CHANGED' });
  if (next === 'completed') await notifyUnblocked(ctx.actor, updated);
  await syncAgencyTaskToSalesPortal({ organizationId: ctx.organizationId, task: updated, actorEmail: ctx.actor.email, notify: false });
  return updated;
}

async function loadTask(ctx: CrudContext, id: string) {
  if (!isObjectId(id)) throw new NotFoundError('Task');
  const task = (await Task.findOne({ _id: id, organizationId: ctx.organizationId, recordStatus: { $ne: 'archived' } }).lean()) as OsDoc | null;
  if (!task) throw new NotFoundError('Task');
  const perms = ctx.req.user!.permissions;
  if (!manageAll(perms)) {
    if (task.projectId) {
      const ids = (await scopedProjectIds(ctx)).map(String);
      if (!ids.includes(String(task.projectId)) && String(task.assignedTo) !== ctx.actor.userId) throw new NotFoundError('Task');
    } else if (!permissionsAllow(perms, 'tasks:write') && String(task.assignedTo) !== ctx.actor.userId) {
      throw new ForbiddenError('You cannot view this task');
    }
  }
  return task;
}

function sumSessions(sessions: OsDoc[], now = Date.now()) {
  return sessions.reduce((s, x) => {
    if (x.durationMs && x.endedAt) return s + x.durationMs;
    const d = (x.endedAt ? new Date(x.endedAt).getTime() : now) - new Date(x.startedAt).getTime();
    return s + Math.max(0, d);
  }, 0);
}

export const taskRoutes = crudRouter({
  model: asOs(Task),
  resource: 'tasks',
  entityType: 'task',
  label: 'Task',
  actorAsUserId: true,
  searchFields: ['title', 'description'],
  filterFields: ['status', 'priority', 'projectId', 'assignedTo', 'leadId'],
  populate: [{ path: 'assignedTo', select: 'firstName lastName email avatar' }, { path: 'projectId', select: 'name' }],
  defaultSort: { dueDate: 1, createdAt: -1 },
  titleOf: (d) => d.title,
  createSchema: taskSchema,
  updateSchema: taskSchema.partial(),
  scope: async (ctx) => {
    const q = ctx.req.query as Record<string, string>;
    const view = q.view || 'all';
    const me = oid(ctx.actor.userId!);
    const filter: Record<string, unknown> = {};
    if (!manageAll(ctx.req.user!.permissions)) {
      filter.$and = [{ $or: [{ projectId: { $in: await scopedProjectIds(ctx) } }, { assignedTo: me }] }];
    }
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 86_400_000);
    const open = { $nin: ['completed', 'cancelled'] };
    if (view === 'my') filter.assignedTo = me;
    if (view === 'today') Object.assign(filter, { dueDate: { $gte: start, $lt: end }, status: open });
    if (view === 'upcoming') Object.assign(filter, { dueDate: { $gte: end }, status: open });
    if (view === 'overdue') Object.assign(filter, { dueDate: { $lt: start }, status: open });
    if (['blocked', 'in_progress', 'completed'].includes(view)) filter.status = view;
    return filter;
  },
  prepare: async (data, ctx, existing) => {
    const projectId = (data.projectId as string) || (existing?.projectId ? String(existing.projectId) : undefined);
    if (data.assignedTo !== undefined && String(data.assignedTo) !== String(existing?.assignedTo || '')) {
      await resolveAssignee(ctx, data.assignedTo as string, projectId);
    }
    if (!existing && !data.assignedTo) throw new ValidationError('Assignee is required');
    if (data.projectId && data.projectId !== String(existing?.projectId || '')) {
      const project = await Project.findOne({ _id: data.projectId, organizationId: ctx.organizationId }).select('conversionUuid').lean();
      if (!project) throw new ValidationError('Project not found');
      data.conversionUuid = project.conversionUuid || '';
    }
    if (data.ownerSide === 'client') Object.assign(data, { visibleToClient: true, clientActionRequired: true });
    if (!existing) data.status = 'todo';
    return data;
  },
  afterCreate: async (doc, ctx) => {
    const mirrored = await syncAgencyTaskToSalesPortal({
      organizationId: ctx.organizationId, task: doc, actorEmail: ctx.actor.email, notify: true,
    });
    if (!mirrored && doc.assignedTo && String(doc.assignedTo) !== ctx.actor.userId) {
      await notifyStaff(ctx.organizationId, {
        title: `New task: ${doc.title}`,
        body: doc.dueDate ? `Due ${new Date(doc.dueDate).toDateString()}` : '',
        href: `/tasks/${doc._id}`,
        recipientUserIds: [String(doc.assignedTo)],
        emailCategory: 'tasks',
      });
    }
    await logActivity(ctx.actor, { title: 'Task assigned', detail: doc.title, entityType: 'task', entityId: String(doc._id), projectId: doc.projectId ? String(doc.projectId) : undefined, actionType: 'TASK_ASSIGNED' });
  },
  afterUpdate: async (doc, prev, ctx) => {
    const reassigned = String(doc.assignedTo || '') !== String(prev.assignedTo || '');
    const mirrored = await syncAgencyTaskToSalesPortal({
      organizationId: ctx.organizationId, task: doc, actorEmail: ctx.actor.email, notify: reassigned,
    });
    if (reassigned && doc.assignedTo) {
      if (!mirrored) {
        await notifyStaff(ctx.organizationId, { title: `Task reassigned to you: ${doc.title}`, href: `/tasks/${doc._id}`, recipientUserIds: [String(doc.assignedTo)], excludeUserId: ctx.actor.userId, emailCategory: 'tasks' });
      }
      await logActivity(ctx.actor, { title: 'Task reassigned', detail: doc.title, entityType: 'task', entityId: String(doc._id), actionType: 'TASK_REASSIGNED' });
    }
    if (String(doc.dueDate || '') !== String(prev.dueDate || '')) {
      await logActivity(ctx.actor, { title: 'Task due date changed', detail: doc.title, entityType: 'task', entityId: String(doc._id), actionType: 'TASK_DUE_DATE_CHANGED' });
    }
  },
  extend: (router) => {
    router.get(
      '/:id/details',
      authorize('tasks:read'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        const [populated, comments, deps, sessions, activity, siblings] = await Promise.all([
          Task.findById(task._id).populate('assignedTo', 'firstName lastName email').populate('projectId', 'name').lean(),
          TaskComment.find({ taskId: task._id, recordStatus: 'active' }).populate('userId', 'firstName lastName email').sort({ createdAt: 1 }).lean(),
          TaskDependency.find({ taskId: task._id }).populate('dependsOnTaskId', 'title status').lean(),
          TaskWorkSession.find({ taskId: task._id }).sort({ startedAt: -1 }).lean(),
          ActivityEvent.find({ organizationId: oid(ctx.organizationId), entityType: 'task', entityId: String(task._id) }).sort({ createdAt: -1 }).limit(40).lean(),
          task.projectId ? Task.find({ projectId: task.projectId, _id: { $ne: task._id }, recordStatus: { $ne: 'archived' } }).select('title status').lean() : [],
        ]);
        return { task: populated, comments, dependencies: deps, sessions, activity, siblings, trackedMs: sumSessions(sessions), openSession: sessions.find((s) => !s.endedAt) || null };
      })
    );

    router.post(
      '/:id/status',
      authorize('tasks:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const status = String(req.body?.status || '');
        if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new ValidationError('Invalid status');
        const task = await loadTask(ctx, req.params.id as string);
        return transitionTask(ctx, task, status, Boolean(req.body?.overrideDeps));
      })
    );

    router.post(
      '/:id/start',
      authorize('tasks:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        if (await TaskWorkSession.exists({ taskId: task._id, endedAt: { $exists: false } })) throw new ValidationError('Timer is already running');
        const updated = task.status === 'in_progress' ? task : await transitionTask(ctx, task, 'in_progress', Boolean(req.body?.overrideDeps));
        await TaskWorkSession.create({ organizationId: ctx.organizationId, taskId: task._id, userId: ctx.actor.userId, startedAt: new Date(), createdBy: ctx.actor.email });
        await logActivity(ctx.actor, { title: 'Task started', detail: task.title, entityType: 'task', entityId: String(task._id), actionType: 'TASK_STARTED' });
        return updated;
      })
    );

    router.post(
      '/:id/pause',
      authorize('tasks:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        await closeOpenSession(task._id);
        await logActivity(ctx.actor, { title: 'Task paused', detail: task.title, entityType: 'task', entityId: String(task._id), actionType: 'TASK_PAUSED' });
        return task;
      })
    );

    router.post(
      '/:id/comments',
      authorize('tasks:read'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        const message = String(req.body?.message || '').trim();
        if (!message) throw new ValidationError('Write a comment first');
        const comment = await TaskComment.create({ organizationId: ctx.organizationId, taskId: task._id, userId: ctx.actor.userId, message, createdBy: ctx.actor.email });
        const mentions = Array.from(new Set((message.match(/@[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).map((m) => m.slice(1).toLowerCase())));
        if (mentions.length) await notifyStaff(ctx.organizationId, { title: `You were mentioned on ${task.title}`, body: message, href: `/tasks/${task._id}`, recipientEmails: mentions, excludeUserId: ctx.actor.userId });
        if (task.assignedTo && String(task.assignedTo) !== ctx.actor.userId) await notifyStaff(ctx.organizationId, { title: `New comment on ${task.title}`, body: message, href: `/tasks/${task._id}`, recipientUserIds: [String(task.assignedTo)] });
        await logActivity(ctx.actor, { title: 'Task comment added', detail: task.title, entityType: 'task', entityId: String(task._id), actionType: 'TASK_COMMENT_ADDED' });
        return comment.populate('userId', 'firstName lastName email');
      })
    );

    router.post(
      '/:id/dependencies',
      authorize('tasks:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        const dependsOnTaskId = String(req.body?.dependsOnTaskId || '');
        if (!isObjectId(dependsOnTaskId)) throw new ValidationError('Select a task');
        const blocker = await Task.findOne({ _id: dependsOnTaskId, organizationId: ctx.organizationId }).lean();
        if (!blocker) throw new NotFoundError('Task');
        if (task.projectId && blocker.projectId && String(task.projectId) !== String(blocker.projectId)) throw new ValidationError('Dependencies must be in the same project');
        // Cycle check: walking dependents from `task` must never reach the proposed blocker.
        const edges = await TaskDependency.find({ organizationId: ctx.organizationId }).select('taskId dependsOnTaskId').lean();
        const dependentsOf = new Map<string, string[]>();
        for (const e of [...edges, { taskId: task._id, dependsOnTaskId: blocker._id }]) {
          const key = String(e.dependsOnTaskId);
          dependentsOf.set(key, [...(dependentsOf.get(key) || []), String(e.taskId)]);
        }
        const stack = [String(task._id)];
        const seen = new Set<string>();
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === String(blocker._id)) throw new ValidationError('This dependency would create a cycle');
          if (seen.has(cur)) continue;
          seen.add(cur);
          stack.push(...(dependentsOf.get(cur) || []));
        }
        try {
          await TaskDependency.create({ organizationId: ctx.organizationId, taskId: task._id, dependsOnTaskId: blocker._id, createdBy: ctx.actor.email });
        } catch {
          throw new ValidationError('Dependency already exists');
        }
        await logActivity(ctx.actor, { title: 'Task dependency added', detail: `${task.title} ← ${blocker.title}`, entityType: 'task', entityId: String(task._id), actionType: 'TASK_DEPENDENCY_ADDED' });
        return TaskDependency.find({ taskId: task._id }).populate('dependsOnTaskId', 'title status').lean();
      })
    );

    router.delete(
      '/:id/dependencies/:depId',
      authorize('tasks:write'),
      route(async (req) => {
        const ctx = ctxOf(req);
        const task = await loadTask(ctx, req.params.id as string);
        await TaskDependency.deleteOne({ _id: req.params.depId, taskId: task._id });
        await logActivity(ctx.actor, { title: 'Task dependency removed', detail: task.title, entityType: 'task', entityId: String(task._id), actionType: 'TASK_DEPENDENCY_REMOVED' });
        return { removed: true };
      })
    );
  },
});

// ---------------------------------------------------------------- meetings
const meetingSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  title: z.string().min(1, 'Title is required'),
  startsAt: z.string().min(1, 'Date and time is required'),
  meetingType: z.enum(MEETING_TYPES).optional(),
  location: z.string().optional(),
  participants: z.string().optional(),
  discussion: z.string().optional(),
  decisions: z.string().optional(),
  actionItems: z.string().optional(),
  nextFollowUp: z.string().optional(),
  attachmentsNote: z.string().optional(),
  visibleToClient: z.boolean().optional(),
});

export const meetingRoutes = crudRouter({
  model: Meeting,
  resource: 'meetings',
  entityType: 'meeting',
  label: 'Meeting',
  searchFields: ['title', 'participants', 'discussion'],
  filterFields: ['projectId', 'meetingType', 'conversionUuid'],
  dateField: 'startsAt',
  populate: { path: 'projectId', select: 'name' },
  defaultSort: { startsAt: -1 },
  createSchema: meetingSchema,
  updateSchema: meetingSchema.partial(),
  prepare: async (data, ctx, existing) => {
    if (data.projectId && data.projectId !== String(existing?.projectId || '')) {
      const project = await Project.findOne({ _id: data.projectId, organizationId: ctx.organizationId }).select('conversionUuid vendorId').lean();
      if (!project) throw new ValidationError('Project not found');
      Object.assign(data, { conversionUuid: project.conversionUuid || '', vendorId: project.vendorId });
    }
    return data;
  },
  afterCreate: async (doc, ctx) => {
    if (doc.actionItems?.trim()) {
      await Task.create({
        organizationId: ctx.organizationId, conversionUuid: doc.conversionUuid, projectId: doc.projectId, meetingId: doc._id,
        title: `Follow-up: ${doc.title}`, description: doc.actionItems, dueDate: doc.nextFollowUp, status: 'todo',
        assignedTo: ctx.actor.userId, createdBy: ctx.actor.userId,
      });
    }
  },
});

// ---------------------------------------------------------------- documents
const MAX_DOC_BYTES = 6 * 1024 * 1024;
const documentSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  conversionUuid: z.string().optional(),
  projectId: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  dataBase64: z.string().optional(),
  visibleToClient: z.boolean().optional(),
});

export const documentRoutes = crudRouter({
  model: OsDocument,
  resource: 'documents',
  entityType: 'document',
  label: 'Document',
  searchFields: ['title', 'fileName'],
  filterFields: ['projectId', 'conversionUuid', 'visibleToClient'],
  populate: { path: 'projectId', select: 'name' },
  createSchema: documentSchema,
  updateSchema: z.object({ title: z.string().min(1).optional(), visibleToClient: z.boolean().optional() }),
  prepare: async (data, ctx, existing) => {
    if (existing) return data;
    if (data.dataBase64) {
      const raw = String(data.dataBase64).replace(/^data:[^;]+;base64,/, '');
      const size = Math.floor((raw.length * 3) / 4);
      if (size > MAX_DOC_BYTES) throw new ValidationError('File must be under 6MB');
      Object.assign(data, { dataBase64: raw, size, mimeType: data.mimeType || 'application/octet-stream' });
    }
    if (data.projectId) {
      const project = await Project.findOne({ _id: data.projectId, organizationId: ctx.organizationId }).select('conversionUuid vendorId').lean();
      if (!project) throw new ValidationError('Project not found');
      Object.assign(data, { conversionUuid: data.conversionUuid || project.conversionUuid, vendorId: project.vendorId });
    } else if (data.conversionUuid) {
      const vendor = await Vendor.findOne({ organizationId: ctx.organizationId, conversionUuid: data.conversionUuid }).select('_id').lean();
      if (vendor) data.vendorId = vendor._id;
    }
    return data;
  },
  transform: (d) => {
    const { dataBase64, ...rest } = d;
    return { ...rest, hasFile: Boolean(d.size || dataBase64) };
  },
  extend: (router) => {
    router.get(
      '/:id/download',
      authorize('documents:read'),
      route(async (req, res) => {
        const doc = await OsDocument.findOne({ _id: req.params.id, organizationId: req.user!.organizationId, recordStatus: 'active' }).select('+dataBase64').lean();
        if (!doc?.dataBase64) throw new NotFoundError('File');
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName || doc.title)}"`);
        res.send(Buffer.from(doc.dataBase64, 'base64'));
      })
    );
  },
});
