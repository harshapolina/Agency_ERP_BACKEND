import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';
import { PROJECT_PRIORITIES, PROJECT_STATUSES, LEGACY_PROJECT_STATUSES, RECORD_STATUSES } from '../shared/constants/os.js';

export interface IProject extends Document {
  organizationId: Types.ObjectId;
  name: string;
  description?: string;
  clientId?: Types.ObjectId;
  leadId?: Types.ObjectId;
  conversionUuid?: string;
  conversionId?: Types.ObjectId;
  vendorId?: Types.ObjectId;
  service?: string;
  status: string;
  priority: string;
  startDate?: Date;
  endDate?: Date;
  expectedDelivery?: Date;
  actualCompletion?: Date;
  primaryPocUserId?: Types.ObjectId;
  budget?: number;
  spent?: number;
  progress: number;
  assignedTeam: Types.ObjectId[];
  recordStatus: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: String,
    clientId: { type: Schema.Types.ObjectId, ref: 'User' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    conversionUuid: { type: String, index: true },
    conversionId: { type: Schema.Types.ObjectId, ref: 'Conversion' },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
    service: { type: String, default: '' },
    status: {
      type: String,
      enum: [...PROJECT_STATUSES, ...LEGACY_PROJECT_STATUSES],
      default: 'planned',
      index: true,
    },
    priority: { type: String, enum: PROJECT_PRIORITIES, default: 'medium' },
    startDate: Date,
    endDate: Date,
    expectedDelivery: Date,
    actualCompletion: Date,
    primaryPocUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    budget: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    assignedTeam: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    recordStatus: { type: String, enum: RECORD_STATUSES, default: 'active', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

void mongoose;
export const Project = tenantModel<IProject>('Project', projectSchema);
