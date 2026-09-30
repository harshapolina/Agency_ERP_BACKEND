import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { TrackerRow, TrackerCheckIn, Project, User } from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { route, parseBody, oid } from '../../../shared/utils/crud.js';
import { actorFrom, notifyStaff, type Actor } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { TRACKER_STATUSES, TRACKER_PRIORITIES, TRACKER_KINDS } from '../../../shared/constants/os.js';
import {
  reopenStaleDailyRows, parseIstDateTime, formatIst, isTrackerDone, istDayKey,
  runDailyReminders, runDeadlineReminders, sendTrackerRowReminder,
} from '../services/reminders.service.js';
import type { OsDoc } from '../../../models/os/base.js';

const router = Router();
router.use(authenticate, authorize('tracker:write'));

const LABELS: Record<string, Record<string, string>> = {
  status: { started: 'Started', in_progress: 'In Progress', completed: 'Completed', not_needed: 'Not needed / cancelled', blocked: 'Blocked', recursive: 'Recursive', not_yet_started: 'Not Yet started' },
  priority: { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' },
  kind: { deadline: 'Deadline task', daily: 'Daily task' },
};

async function teamOf(organizationId: string) {
  const users = await User.find({ organizationId: oid(organizationId), isActive: true, role: { $ne: 'client' } })
    .select('_id firstName lastName email role').sort({ firstName: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, role: u.role }));
}

async function notifyInvolved(actor: Actor, row: OsDoc, title: string, body: string, only?: string[]) {
  const ids = only ?? [row.poc, ...(row.dependency || [])];
  const recipients = Array.from(new Set(ids.filter((id: string) => id && id !== actor.userId && Types.ObjectId.isValid(id))));
  if (!recipients.length) return;
  await notifyStaff(actor.organizationId, { type: 'tracker', title, body, href: '/tracker', recipientUserIds: recipients });
}

router.get(
  '/',
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const org = oid(actor.organizationId);
    await reopenStaleDailyRows(actor.organizationId);
    const dayKey = istDayKey();
    await TrackerCheckIn.updateOne(
      { organizationId: org, email: actor.email, dayKey },
      { $setOnInsert: { organizationId: org, email: actor.email, userId: actor.userId, name: actor.name || '', dayKey, checkedInAt: new Date() } },
      { upsert: true }
    );
    const [rows, checkIns, projects, trackerProjects, team] = await Promise.all([
      TrackerRow.find({ organizationId: org, recordStatus: 'active' }).sort({ date: -1, createdAt: -1 }).limit(300).lean(),
      TrackerCheckIn.find({ organizationId: org, dayKey }).lean(),
      Project.find({ organizationId: org, recordStatus: { $ne: 'archived' } }).distinct('name'),
      TrackerRow.distinct('projectName', { organizationId: org }),
      teamOf(actor.organizationId),
    ]);
    const projectNames = Array.from(new Set([...projects, ...trackerProjects].map((n) => String(n).trim()).filter(Boolean))).sort();
    const byEmail = new Map(checkIns.map((c) => [c.email, c.checkedInAt]));
    return {
      rows,
      team,
      projectNames,
      checkIns: team.map((m) => ({ ...m, checkedInAt: byEmail.get(m.email) ?? null })),
      myCheckInAt: byEmail.get(actor.email) ?? null,
    };
  })
);

const createSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  projectName: z.string().trim().min(1, 'Project name is required'),
  taskName: z.string().trim().min(1, 'Task name is required'),
  dependency: z.array(z.string()).optional(),
  poc: z.string().optional(),
  status: z.enum(TRACKER_STATUSES).optional(),
  remarks: z.string().optional(),
  priority: z.enum(TRACKER_PRIORITIES).optional(),
  kind: z.enum(TRACKER_KINDS).optional(),
  deadline: z.string().optional(),
});

router.post(
  '/',
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const body = parseBody<z.infer<typeof createSchema>>(createSchema, req.body);
    const kind = body.kind || 'deadline';
    const status = body.status || 'not_yet_started';
    const row = await TrackerRow.create({
      organizationId: actor.organizationId,
      date: new Date(body.date),
      projectName: body.projectName,
      taskName: body.taskName,
      dependency: (body.dependency || []).filter((d) => d !== body.poc),
      poc: body.poc || '',
      status,
      remarks: body.remarks || '',
      priority: body.priority || 'medium',
      kind,
      deadline: kind === 'deadline' ? parseIstDateTime(body.deadline) : undefined,
      completedAt: status === 'completed' ? new Date() : undefined,
      history: [{ byEmail: actor.email, byName: actor.name || '', field: 'created', from: '', to: `${body.projectName} · ${body.taskName}` }],
      createdBy: actor.email,
      updatedBy: actor.email,
    });
    const label = `${row.projectName} · ${row.taskName}`;
    const detail = [LABELS.kind[kind], `Priority: ${LABELS.priority[row.priority]}`, row.deadline && `Due ${formatIst(row.deadline)}`, `Added by ${actor.name || actor.email}`].filter(Boolean).join(' · ');
    if (row.poc) await notifyInvolved(actor, row, `Assigned to you: ${label}`, detail, [row.poc]);
    if (row.dependency.length) await notifyInvolved(actor, row, `You're a dependency on: ${label}`, detail, row.dependency);
    res.status(201);
    return row;
  })
);

const fieldSchema = z.object({
  field: z.enum(['status', 'poc', 'dependency', 'remarks', 'projectName', 'taskName', 'priority', 'kind', 'deadline']),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
});

router.patch(
  '/:id',
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const { field, value = '', values = [] } = parseBody<z.infer<typeof fieldSchema>>(fieldSchema, req.body);
    const row = await TrackerRow.findOne({ _id: req.params.id, organizationId: actor.organizationId });
    if (!row) throw new NotFoundError('Row');
    const team = await teamOf(actor.organizationId);
    const nameOf = (id: string) => team.find((m) => m.id === id)?.name || '—';
    const label = `${row.projectName} · ${row.taskName}`;
    const actorName = actor.name || actor.email;
    let from = '';
    let to = '';

    switch (field) {
      case 'status': {
        if (!(TRACKER_STATUSES as readonly string[]).includes(value)) throw new ValidationError('Invalid status');
        from = LABELS.status[row.status]; to = LABELS.status[value];
        const changed = row.status !== value;
        row.status = value;
        row.completedAt = value === 'completed' ? new Date() : undefined;
        if (changed) await notifyInvolved(actor, row, value === 'completed' ? `Completed: ${label}` : `Status ${to}: ${label}`, `${actorName} changed status ${from} → ${to}`);
        break;
      }
      case 'poc': {
        if (value && !team.some((m) => m.id === value)) throw new ValidationError('Invalid POC');
        const prev = row.poc;
        from = prev ? nameOf(prev) : '—'; to = value ? nameOf(value) : '—';
        row.poc = value;
        if (value && value !== prev) await notifyInvolved(actor, row, `Assigned to you: ${label}`, `${actorName} made you the POC${row.deadline ? ` · due ${formatIst(row.deadline)}` : ''}`, [value]);
        if (prev && prev !== value) await notifyInvolved(actor, row, `Reassigned: ${label}`, `${actorName} moved POC from ${from} to ${value ? to : 'nobody'}`, [prev]);
        break;
      }
      case 'dependency': {
        const next = values.filter((v) => team.some((m) => m.id === v));
        const added = next.filter((v) => !row.dependency.includes(v));
        from = row.dependency.map(nameOf).join(', ') || '—'; to = next.map(nameOf).join(', ') || '—';
        row.dependency = next;
        if (added.length) await notifyInvolved(actor, row, `You're a dependency on: ${label}`, `Added by ${actorName}`, added);
        break;
      }
      case 'priority': {
        if (!(TRACKER_PRIORITIES as readonly string[]).includes(value)) throw new ValidationError('Invalid priority');
        from = LABELS.priority[row.priority]; to = LABELS.priority[value];
        const changed = row.priority !== value;
        row.priority = value;
        if (changed && ['urgent', 'high'].includes(value)) await notifyInvolved(actor, row, `Priority ${to}: ${label}`, `${actorName} changed priority ${from} → ${to}`);
        break;
      }
      case 'kind': {
        if (!(TRACKER_KINDS as readonly string[]).includes(value)) throw new ValidationError('Invalid type');
        from = LABELS.kind[row.kind]; to = LABELS.kind[value];
        row.kind = value;
        if (value === 'daily') row.deadline = undefined;
        break;
      }
      case 'deadline': {
        const next = parseIstDateTime(value);
        from = formatIst(row.deadline); to = formatIst(next);
        const changed = String(row.deadline?.getTime?.() ?? '') !== String(next?.getTime() ?? '');
        row.deadline = next;
        if (changed && next) await notifyInvolved(actor, row, `Deadline set: ${label}`, `${actorName} set the deadline to ${to} (was ${from})`);
        break;
      }
      case 'remarks':
        from = row.remarks || '—'; to = value || '—';
        row.remarks = value;
        break;
      case 'projectName':
      case 'taskName': {
        const trimmed = value.trim();
        if (!trimmed) throw new ValidationError(field === 'projectName' ? 'Project name required' : 'Task name required');
        from = row[field]; to = trimmed;
        row[field] = trimmed;
        break;
      }
    }

    if (from !== to) {
      row.history.unshift({ at: new Date(), byEmail: actor.email, byName: actor.name || '', field, from, to });
      row.history = row.history.slice(0, 40);
    }
    row.updatedBy = actor.email;
    await row.save();
    return row;
  })
);

router.delete(
  '/:id',
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const row = await TrackerRow.findOneAndDelete({ _id: req.params.id, organizationId: actor.organizationId }).lean();
    if (!row) throw new NotFoundError('Row');
    await notifyInvolved(actor, row, `Deleted: ${row.projectName} · ${row.taskName}`, `Removed from Master Tracker by ${actor.name || actor.email}`);
    return { id: String(row._id) };
  })
);

router.post(
  '/:id/remind',
  route(async (req) => {
    try {
      const name = await sendTrackerRowReminder(req.user!.organizationId, req.params.id as string);
      return { message: `Reminder sent to ${name}` };
    } catch (error) {
      throw new ValidationError((error as Error).message);
    }
  })
);

router.post(
  '/reminders',
  route(async (req) => {
    const slot = String(req.body?.slot || 'morning');
    if (slot === 'deadline') {
      const n = await runDeadlineReminders(req.user!.organizationId, true);
      return { message: n ? `Sent ${n} deadline reminder${n === 1 ? '' : 's'}` : 'No open tasks with deadlines — nothing to send' };
    }
    const s = slot === 'evening' ? 'evening' : 'morning';
    const n = await runDailyReminders(req.user!.organizationId, s, true);
    return { message: n ? `Sent ${s} reminders to ${n} ${n === 1 ? 'person' : 'people'}` : 'Nothing due — no reminders needed' };
  })
);

void isTrackerDone;
export default router;
