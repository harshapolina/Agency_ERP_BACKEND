import { Types } from 'mongoose';
import { TrackerRow, Task, RecurringPayment, ReminderLog, User, Invoice } from '../../../models/index.js';
import { TRACKER_DONE_STATUSES, TRACKER_PRIORITY_RANK } from '../../../shared/constants/os.js';
import { sendNotificationEmail } from '../../../shared/utils/mailer.js';
import { notifyStaff } from '../../../shared/os/activity.js';
import { notificationRecipients } from '../../../shared/os/company.js';
import { displayInvoiceStatus, outstandingOf } from '../../../shared/os/money.js';
import type { OsDoc } from '../../../models/os/base.js';

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export function istDayStart(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export function istDayKey(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `datetime-local` values carry no zone; the team enters them in IST. */
export function parseIstDateTime(raw?: string | null) {
  const s = (raw || '').trim();
  if (!s) return undefined;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const d = new Date(hasZone ? s : `${s.length === 16 ? `${s}:00` : s}+05:30`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const formatIst = (d?: Date | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';

export const isTrackerDone = (status: string) => TRACKER_DONE_STATUSES.includes(status);

export async function reopenStaleDailyRows(organizationId: string) {
  const todayStart = istDayStart();
  const stale = await TrackerRow.find({
    organizationId, kind: 'daily', status: 'completed',
    $or: [{ completedAt: { $lt: todayStart } }, { completedAt: { $exists: false } }],
  });
  for (const row of stale) {
    row.history.unshift({ at: new Date(), byEmail: 'system', byName: 'System', field: 'status', from: 'Completed', to: 'Not Yet started (new day)' });
    row.history = row.history.slice(0, 40);
    row.status = 'not_yet_started';
    row.completedAt = undefined;
    await row.save();
  }
  return stale.length;
}

async function alreadySent(organizationId: string, key: string, email: string, slot: string) {
  try {
    await ReminderLog.create({ organizationId, key, email, slot, dayKey: istDayKey() });
    return false;
  } catch {
    return true;
  }
}

const rowLabel = (r: OsDoc) => `${r.projectName} — ${r.taskName}${r.priority === 'urgent' ? ' [Urgent]' : r.priority === 'high' ? ' [High]' : ''}`;
const sortByPriority = (a: OsDoc, b: OsDoc) => (TRACKER_PRIORITY_RANK[a.priority] ?? 9) - (TRACKER_PRIORITY_RANK[b.priority] ?? 9);

export async function runDailyReminders(organizationId: string, slot: 'morning' | 'evening', force = false) {
  await reopenStaleDailyRows(organizationId);
  const org = new Types.ObjectId(organizationId);
  const now = new Date();
  const todayStart = istDayStart(now);
  const todayEnd = new Date(todayStart.getTime() + DAY);
  const tomorrowEnd = new Date(todayStart.getTime() + 2 * DAY);
  const soonEnd = new Date(todayStart.getTime() + 4 * DAY);

  const [users, rows, tasks, recurring, financeList] = await Promise.all([
    User.find({ organizationId: org, isActive: true }).select('_id email firstName lastName role').lean(),
    TrackerRow.find({ organizationId: org, recordStatus: 'active', status: { $nin: TRACKER_DONE_STATUSES } }).lean(),
    Task.find({ organizationId: org, recordStatus: { $ne: 'archived' }, status: { $nin: ['completed', 'cancelled'] }, assignedTo: { $exists: true }, dueDate: { $lt: todayEnd } }).lean(),
    RecurringPayment.find({ organizationId: org, recordStatus: 'active', status: 'active', nextDueAt: { $lt: slot === 'morning' ? soonEnd : tomorrowEnd } }).sort({ nextDueAt: 1 }).lean(),
    notificationRecipients(organizationId, 'finance'),
  ]);
  const financeEmails = new Set(financeList);

  let sent = 0;
  for (const user of users) {
    const uid = String(user._id);
    const mine = rows.filter((r) => r.poc === uid).sort(sortByPriority);
    const sections: { heading: string; items: string[] }[] = [];
    const add = (heading: string, items: string[]) => items.length && sections.push({ heading, items });

    add('Overdue', mine.filter((r) => r.kind === 'deadline' && r.deadline && new Date(r.deadline) < now).map((r) => `${rowLabel(r)} · was due ${formatIst(r.deadline)}`));
    add('Due today', mine.filter((r) => r.kind === 'deadline' && r.deadline && new Date(r.deadline) >= now && new Date(r.deadline) < todayEnd).map((r) => `${rowLabel(r)} · by ${formatIst(r.deadline)}`));
    add(slot === 'morning' ? 'Daily tasks for today' : 'Daily tasks not done yet', mine.filter((r) => r.kind === 'daily').map(rowLabel));
    add('Due tomorrow', mine.filter((r) => r.kind === 'deadline' && r.deadline && new Date(r.deadline) >= todayEnd && new Date(r.deadline) < tomorrowEnd).map((r) => `${rowLabel(r)} · ${formatIst(r.deadline)}`));
    if (slot === 'morning') {
      add('Coming up in 3 days', mine.filter((r) => r.kind === 'deadline' && r.deadline && new Date(r.deadline) >= tomorrowEnd && new Date(r.deadline) < soonEnd).map((r) => `${rowLabel(r)} · ${formatIst(r.deadline)}`));
      add('Open without a deadline', mine.filter((r) => r.kind === 'deadline' && !r.deadline).map(rowLabel));
      add('Waiting on you (dependency)', rows.filter((r) => r.poc !== uid && (r.dependency || []).includes(uid)).map((r) => rowLabel(r)));
    }
    const myTasks = tasks.filter((t) => String(t.assignedTo) === uid);
    add('Overdue tasks', myTasks.filter((t) => t.dueDate && new Date(t.dueDate) < todayStart).map((t) => `${t.title} · was due ${formatIst(t.dueDate)}`));
    add('Tasks due today', myTasks.filter((t) => t.dueDate && new Date(t.dueDate) >= todayStart).map((t) => t.title));

    const isFinance = ['finance', 'admin'].includes(user.role) || financeEmails.has(user.email.toLowerCase());
    if (isFinance && recurring.length) {
      add('Recurring payments due', recurring.map((r) => `${r.title}${r.payee ? ` (${r.payee})` : ''} · ₹${Number(r.amount).toLocaleString('en-IN')} · ${new Date(r.nextDueAt) < todayStart ? 'OVERDUE since' : 'due'} ${formatIst(r.nextDueAt)}`));
    }

    if (!sections.length) continue;
    if (!force && (await alreadySent(organizationId, `${istDayKey()}:${slot}:${user.email}`, user.email, slot))) continue;

    const lines = sections.flatMap((s) => [`${s.heading}:`, ...s.items.map((i) => `  • ${i}`)]);
    const subject = slot === 'morning'
      ? `Good morning ${user.firstName} — your plan for ${formatIst(now).split(',')[0]}`
      : `6 PM check-in ${user.firstName} — finish these before you log off`;
    await sendNotificationEmail(user.email, { title: subject, lines, href: '/tracker', ctaLabel: 'Open Master Tracker →' }, subject, { organizationId });
    sent++;
  }
  return sent;
}

function timeLeft(deadline: Date, now = new Date()) {
  const diff = deadline.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / (60 * 60 * 1000));
  const text = `${days ? `${days} day${days > 1 ? 's' : ''} ` : ''}${hours} hour${hours === 1 ? '' : 's'}`;
  return { overdue: diff < 0, text };
}

export async function runDeadlineReminders(organizationId: string, force = false) {
  const org = new Types.ObjectId(organizationId);
  const hourKey = new Date().toISOString().slice(0, 13);
  const [users, rows, tasks] = await Promise.all([
    User.find({ organizationId: org, isActive: true }).select('_id email firstName').lean(),
    TrackerRow.find({ organizationId: org, recordStatus: 'active', kind: 'deadline', status: { $nin: TRACKER_DONE_STATUSES }, deadline: { $exists: true }, poc: { $ne: '' } }).sort({ deadline: 1 }).lean(),
    Task.find({ organizationId: org, recordStatus: { $ne: 'archived' }, status: { $nin: ['completed', 'cancelled'] }, assignedTo: { $exists: true }, dueDate: { $exists: true, $lt: new Date(Date.now() + 3 * DAY) } }).lean(),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  let sent = 0;

  const deliver = async (key: string, email: string, label: string, deadline: Date, priority: string, href: string) => {
    if (!force && (await alreadySent(organizationId, `${hourKey}:deadline:${key}`, email, 'deadline'))) return;
    const { overdue, text } = timeLeft(deadline);
    const subject = overdue ? `Overdue: ${label} (overdue by ${text})` : `Reminder: ${label} — ${text} left`;
    await sendNotificationEmail(email, {
      title: subject,
      lines: [`Task: ${label}`, `Priority: ${priority}`, `Deadline: ${formatIst(deadline)} IST`, `Time remaining: ${overdue ? `overdue by ${text}` : text}`],
      href,
    }, subject, { organizationId });
    sent++;
  };

  for (const r of rows) {
    const u = byId.get(r.poc);
    if (u) await deliver(`tracker:${r._id}`, u.email, `${r.projectName} — ${r.taskName}`, new Date(r.deadline), r.priority, '/tracker');
  }
  for (const t of tasks) {
    const u = byId.get(String(t.assignedTo));
    if (u) await deliver(`task:${t._id}`, u.email, t.title, new Date(t.dueDate!), t.priority, `/tasks`);
  }
  return sent;
}

export async function sendTrackerRowReminder(organizationId: string, rowId: string) {
  const row = await TrackerRow.findOne({ _id: rowId, organizationId }).lean();
  if (!row) throw new Error('Row not found');
  if (isTrackerDone(row.status)) throw new Error('This task is already done');
  if (!row.poc) throw new Error('Set a POC first');
  const poc = await User.findById(row.poc).select('email firstName lastName').lean();
  if (!poc?.email) throw new Error('POC has no email configured');
  const label = `${row.projectName} — ${row.taskName}`;
  if (row.kind === 'deadline' && row.deadline) {
    const { overdue, text } = timeLeft(new Date(row.deadline));
    await sendNotificationEmail(poc.email, {
      title: overdue ? `Overdue: ${label}` : `Reminder: ${label} — ${text} left`,
      lines: [`Priority: ${row.priority}`, `Deadline: ${formatIst(row.deadline)} IST`],
      href: '/tracker',
    }, undefined, { organizationId });
  } else {
    await sendNotificationEmail(poc.email, { title: `Reminder: ${label}`, body: row.remarks || '', href: '/tracker' }, undefined, { organizationId });
  }
  await notifyStaff(organizationId, { type: 'tracker', title: `Reminder: ${label}`, href: '/tracker', recipientUserIds: [row.poc], email: false });
  return `${poc.firstName} ${poc.lastName}`.trim();
}

export async function recurringPaymentReminders(organizationId: string) {
  const soon = new Date(Date.now() + 7 * DAY);
  const due = await RecurringPayment.find({ organizationId, recordStatus: 'active', status: 'active', nextDueAt: { $lte: soon } }).sort({ nextDueAt: 1 }).lean();
  if (!due.length) return 0;
  const body = due.slice(0, 8).map((r) => `${r.title}: ₹${Number(r.amount).toLocaleString('en-IN')} · ${formatIst(r.nextDueAt)}`).join(' · ');
  await notifyStaff(organizationId, { type: 'recurring_payment', title: `Recurring payments due (${due.length})`, body, href: '/recurring-payments', recipientRoles: ['finance', 'admin'], emailCategory: 'finance' });
  await RecurringPayment.updateMany({ _id: { $in: due.map((d) => d._id) } }, { $set: { lastRemindedAt: new Date() } });
  return due.length;
}

export async function dashboardAlerts(organizationId: string) {
  const org = new Types.ObjectId(organizationId);
  const now = new Date();
  const [invoices, recurring, overdueTasks] = await Promise.all([
    Invoice.find({ organizationId: org, recordStatus: 'active', status: { $nin: ['draft', 'cancelled'] } }).select('total amountPaid status dueDate').lean(),
    RecurringPayment.countDocuments({ organizationId: org, recordStatus: 'active', status: 'active', nextDueAt: { $lte: new Date(now.getTime() + 7 * DAY) } }),
    Task.countDocuments({ organizationId: org, recordStatus: { $ne: 'archived' }, status: { $nin: ['completed', 'cancelled'] }, dueDate: { $lt: now } }),
  ]);
  const overdue = invoices.filter((i) => displayInvoiceStatus({ status: i.status, dueDate: i.dueDate, amountPaid: i.amountPaid || 0, total: i.total || 0 }) === 'overdue');
  return {
    overdueInvoices: overdue.length,
    overdueAmount: overdue.reduce((s, i) => s + outstandingOf(i.total || 0, i.amountPaid || 0), 0),
    recurringDueSoon: recurring,
    overdueTasks,
  };
}
