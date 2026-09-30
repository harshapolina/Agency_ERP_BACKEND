import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface ILeadCategory extends Document {
  organizationId: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
  customFields: Array<{
    key: string;
    label: string;
    type: 'text' | 'number' | 'email' | 'phone' | 'date' | 'select' | 'boolean' | 'url';
    required: boolean;
    options?: string[];
  }>;
  pipelineStages: string[];
  assignedTeam: Types.ObjectId[];
  permissions: Record<string, string[]>;
  isActive: boolean;
  leadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const leadCategorySchema = new Schema<ILeadCategory>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true },
    description: String,
    icon: String,
    color: { type: String, default: '#3b82f6' },
    customFields: [{
      key: { type: String, required: true },
      label: { type: String, required: true },
      type: { type: String, enum: ['text', 'number', 'email', 'phone', 'date', 'select', 'boolean', 'url'], default: 'text' },
      required: { type: Boolean, default: false },
      options: [String],
    }],
    pipelineStages: {
      type: [String],
      default: ['new', 'not_contacted', 'attempt_1', 'attempt_2', 'connected', 'interested', 'meeting', 'demo', 'proposal', 'negotiation', 'won', 'lost', 'future_follow_up', 'dormant'],
    },
    assignedTeam: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    permissions: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    leadCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

leadCategorySchema.index({ organizationId: 1, slug: 1 }, { unique: true });

export const LeadCategory = tenantModel<ILeadCategory>('LeadCategory', leadCategorySchema);
