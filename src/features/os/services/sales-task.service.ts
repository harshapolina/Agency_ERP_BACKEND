import { SalesEmployee, SalesTask } from '../../../models/index.js';
import { notifyStaff } from '../../../shared/os/activity.js';

const SALES_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);

function mapStatus(status: string | undefined) {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'blocked') return 'in_progress';
  return 'todo';
}

/**
 * When an agency Delivery task is assigned to a Sales / BDA user, mirror it into SalesTask
 * so it shows on /bda (My Day + Tasks). Non-sales assignees are ignored.
 */
export async function syncAgencyTaskToSalesPortal(opts: {
  organizationId: string;
  task: {
    _id?: unknown;
    title?: string;
    description?: string;
    priority?: string;
    dueDate?: Date | string | null;
    status?: string;
    assignedTo?: unknown;
    recordStatus?: string;
  };
  actorEmail?: string;
  notify?: boolean;
}) {
  const userId = opts.task.assignedTo ? String(opts.task.assignedTo) : '';
  if (!userId) return null;

  const employee = await SalesEmployee.findOne({
    organizationId: opts.organizationId,
    userId,
    recordStatus: { $ne: 'archived' },
    status: { $ne: 'inactive' },
  }).lean();
  if (!employee) return null;

  const agencyTaskId = String(opts.task._id);
  const title = String(opts.task.title || 'Task');
  const payload = {
    title,
    description: opts.task.description || '',
    priority: SALES_PRIORITIES.has(String(opts.task.priority || '')) ? opts.task.priority : 'medium',
    dueDate: opts.task.dueDate || undefined,
    ownerEmployeeId: employee._id,
    status: opts.task.recordStatus === 'archived' ? 'completed' : mapStatus(opts.task.status),
    agencyTaskId,
    updatedBy: opts.actorEmail || 'system',
  };

  let row = await SalesTask.findOne({ organizationId: opts.organizationId, agencyTaskId });
  const isNew = !row;
  if (row) {
    Object.assign(row, payload);
    await row.save();
  } else {
    row = await SalesTask.create({
      ...payload,
      organizationId: opts.organizationId,
      createdBy: opts.actorEmail || 'system',
    });
  }

  if (opts.notify !== false && isNew) {
    await notifyStaff(opts.organizationId, {
      type: 'task_assigned',
      title: `New task: ${title}`,
      body: opts.task.dueDate ? `Due ${new Date(opts.task.dueDate).toDateString()}` : 'Open it in your BDA portal',
      href: '/bda/tasks',
      recipientUserIds: [userId],
      emailCategory: 'tasks',
    });
  }

  return row;
}
