import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface IProjectRevenueEntry extends Document {
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  type: 'credit' | 'debit';
  amount: number;
  description: string;
  recordedAt: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectRevenueEntrySchema = new Schema<IProjectRevenueEntry>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
    recordedAt: { type: Date, required: true, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

projectRevenueEntrySchema.index({ organizationId: 1, projectId: 1, recordedAt: -1 });

export const ProjectRevenueEntry = tenantModel<IProjectRevenueEntry>('ProjectRevenueEntry',
  projectRevenueEntrySchema
);
