import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type LeadActivityType = 'call' | 'email' | 'meeting' | 'whatsapp' | 'note' | 'status_change' | 'assignment' | 'document' | 'proposal' | 'invoice';

export interface ILeadActivity extends Document {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  type: LeadActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const leadActivitySchema = new Schema<ILeadActivity>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  type: {
    type: String,
    enum: ['call', 'email', 'meeting', 'whatsapp', 'note', 'status_change', 'assignment', 'document', 'proposal', 'invoice'],
    required: true,
  },
  title: { type: String, required: true },
  description: String,
  metadata: Schema.Types.Mixed,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

leadActivitySchema.index({ leadId: 1, createdAt: -1 });

export const LeadActivity = tenantModel<ILeadActivity>('LeadActivity', leadActivitySchema);
