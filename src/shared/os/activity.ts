import { Types } from 'mongoose';
import { ActivityEvent, FieldAuditLog, Notification, User } from '../../models/index.js';
import type { AuthUser } from '../types/index.js';
import { sendNotificationEmail } from '../utils/mailer.js';
import { logger } from '../logger/index.js';
import type { NotificationCategory } from '../constants/os.js';
import { notificationRecipients } from './company.js';

export interface Actor {
  organizationId: string;
  userId?: string;
  email: string;
  name?: string;
}

export function actorFrom(user: AuthUser): Actor {
  return { organizationId: user.organizationId, userId: user.id, email: user.email, name: user.name };
}

export interface LogActivityInput {
  title: string;
  detail?: string;
  entityType: string;
  entityId?: string;
  actionType?: string;
  conversionUuid?: string;
  leadId?: string;
  vendorId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(actor: Actor, input: LogActivityInput) {
  try {
    await ActivityEvent.create({
      organizationId: actor.organizationId,
      ...input,
      detail: input.detail || '',
      actionType: input.actionType || '',
      entityId: input.entityId || '',
      actorUserId: actor.userId,
      actorName: actor.name || '',
      createdBy: actor.email,
      metadata: input.metadata || {},
    });
  } catch (error) {
    logger.error('logActivity failed', { error: (error as Error).message, title: input.title });
  }
}

export interface NotifyInput {
  type?: string;
  title: string;
  body?: string;
  href?: string;
  entityType?: string;
  entityId?: string;
  recipientUserIds?: string[];
  recipientEmails?: string[];
  recipientRoles?: string[];
  excludeUserId?: string;
  email?: boolean;
  /** Also emails the addresses the company configured for this category in Settings. */
  emailCategory?: NotificationCategory;
}

/**
 * In-app notification (+ optional email) routed like the spec's `notifyStaff`:
 * explicit users/emails → those people; roles → active users with those roles; otherwise everyone active.
 */
export async function notifyStaff(organizationId: string, input: NotifyInput) {
  try {
    const orgId = new Types.ObjectId(organizationId);
    const or: Record<string, unknown>[] = [];
    if (input.recipientUserIds?.length) or.push({ _id: { $in: input.recipientUserIds.filter(Boolean) } });
    if (input.recipientEmails?.length) or.push({ email: { $in: input.recipientEmails.map((e) => e.toLowerCase()) } });
    if (input.recipientRoles?.length) or.push({ role: { $in: input.recipientRoles } });

    const filter: Record<string, unknown> = { organizationId: orgId, isActive: true };
    if (or.length) filter.$or = or;
    let recipients = await User.find(filter).select('_id email').lean();
    if (input.excludeUserId) recipients = recipients.filter((r) => r._id.toString() !== input.excludeUserId);

    if (input.emailCategory) {
      const emailed = new Set(input.email === false ? [] : recipients.map((r) => r.email.toLowerCase()));
      const extra = (await notificationRecipients(organizationId, input.emailCategory)).filter((e) => !emailed.has(e));
      await Promise.all(extra.map((e) => sendNotificationEmail(e, { title: input.title, body: input.body, href: input.href }, input.title, { organizationId })));
    }
    if (!recipients.length) return 0;

    await Notification.insertMany(
      recipients.map((r) => ({
        organizationId: orgId,
        userId: r._id,
        type: 'system_alert',
        title: input.title,
        message: input.body || input.title,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: { kind: input.type || 'system', href: input.href || '' },
      }))
    );

    if (input.email !== false) {
      await Promise.all(
        recipients.map((r) => sendNotificationEmail(r.email, { title: input.title, body: input.body, href: input.href }, input.title, { organizationId }))
      );
    }
    return recipients.length;
  } catch (error) {
    logger.error('notifyStaff failed', { error: (error as Error).message, title: input.title });
    return 0;
  }
}

export async function writeAudit(
  actor: Actor,
  input: { entityType: string; entityId: string; conversionUuid?: string; field: string; oldValue: unknown; newValue: unknown; reason?: string }
) {
  try {
    await FieldAuditLog.create({
      organizationId: actor.organizationId,
      ...input,
      oldValue: String(input.oldValue ?? ''),
      newValue: String(input.newValue ?? ''),
      reason: input.reason || '',
      createdBy: actor.email,
    });
  } catch (error) {
    logger.error('writeAudit failed', { error: (error as Error).message });
  }
}
