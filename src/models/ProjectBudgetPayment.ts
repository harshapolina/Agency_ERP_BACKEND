import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface IProjectBudgetPayment extends Document {
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  label: string;
  amount: number;
  status: 'received' | 'pending';
  receivedAt?: Date;
  dueDate?: Date;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectBudgetPaymentSchema = new Schema<IProjectBudgetPayment>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['received', 'pending'], default: 'pending' },
    receivedAt: Date,
    dueDate: Date,
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

projectBudgetPaymentSchema.index({ organizationId: 1, projectId: 1, createdAt: -1 });

export const ProjectBudgetPayment = tenantModel<IProjectBudgetPayment>('ProjectBudgetPayment',
  projectBudgetPaymentSchema
);
