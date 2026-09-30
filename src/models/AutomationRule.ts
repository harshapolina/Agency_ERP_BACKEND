import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface IAutomationRule extends Document {
  organizationId: Types.ObjectId;
  name: string;
  trigger: string;
  action: string;
  status: 'active' | 'draft';
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const automationRuleSchema = new Schema<IAutomationRule>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    trigger: { type: String, required: true },
    action: { type: String, required: true },
    status: { type: String, enum: ['active', 'draft'], default: 'draft' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const AutomationRule = tenantModel<IAutomationRule>('AutomationRule', automationRuleSchema);
