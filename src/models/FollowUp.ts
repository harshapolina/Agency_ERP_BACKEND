import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type FollowUpType = 'phone' | 'whatsapp' | 'email' | 'meeting' | 'visit' | 'demo' | 'proposal' | 'renewal' | 'payment_reminder';
export type FollowUpStatus = 'scheduled' | 'completed' | 'missed' | 'cancelled' | 'escalated';

export interface IFollowUp extends Document {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  assignedTo: Types.ObjectId;
  type: FollowUpType;
  status: FollowUpStatus;
  title: string;
  description?: string;
  scheduledAt: Date;
  completedAt?: Date;
  reminderAt?: Date;
  autoReminder: boolean;
  escalationLevel: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const followUpSchema = new Schema<IFollowUp>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['phone', 'whatsapp', 'email', 'meeting', 'visit', 'demo', 'proposal', 'renewal', 'payment_reminder'], required: true },
    status: { type: String, enum: ['scheduled', 'completed', 'missed', 'cancelled', 'escalated'], default: 'scheduled' },
    title: { type: String, required: true },
    description: String,
    scheduledAt: { type: Date, required: true, index: true },
    completedAt: Date,
    reminderAt: Date,
    autoReminder: { type: Boolean, default: true },
    escalationLevel: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

followUpSchema.index({ organizationId: 1, assignedTo: 1, scheduledAt: 1, status: 1 });

export const FollowUp = tenantModel<IFollowUp>('FollowUp', followUpSchema);
