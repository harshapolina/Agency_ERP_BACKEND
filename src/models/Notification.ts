import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type NotificationType =
  | 'task_assigned' | 'task_updated' | 'task_completed'
  | 'lead_assigned' | 'lead_updated'
  | 'proposal_opened' | 'invoice_paid'
  | 'meeting_reminder' | 'follow_up_reminder'
  | 'deadline_reminder' | 'system_alert' | 'approval_request'
  | 'budget_received' | 'budget_pending' | 'project_spending_added'
  | 'project_revenue_adjusted' | 'finance_updated';

export interface INotification extends Document {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  read: boolean;
  readAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['task_assigned', 'task_updated', 'task_completed', 'lead_assigned', 'lead_updated', 'proposal_opened', 'invoice_paid', 'meeting_reminder', 'follow_up_reminder', 'deadline_reminder', 'system_alert', 'approval_request', 'budget_received', 'budget_pending', 'project_spending_added', 'project_revenue_adjusted', 'finance_updated'],
    required: true,
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  entityType: String,
  entityId: String,
  read: { type: Boolean, default: false, index: true },
  readAt: Date,
  metadata: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, index: true },
});

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const Notification = tenantModel<INotification>('Notification', notificationSchema);
