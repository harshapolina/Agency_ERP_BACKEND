import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type ExpenseCategory =
  | 'marketing' | 'salaries' | 'software' | 'office' | 'travel' | 'utilities' | 'other';

export interface IExpense extends Document {
  organizationId: Types.ObjectId;
  referenceNumber: string;
  title: string;
  amount: number;
  category: ExpenseCategory;
  vendor?: string;
  paymentMethod?: string;
  status: 'paid' | 'pending';
  spentAt: Date;
  notes?: string;
  projectId?: Types.ObjectId;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    referenceNumber: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    category: {
      type: String,
      enum: ['marketing', 'salaries', 'software', 'office', 'travel', 'utilities', 'other'],
      default: 'other',
    },
    vendor: String,
    paymentMethod: String,
    status: { type: String, enum: ['paid', 'pending'], default: 'paid' },
    spentAt: { type: Date, required: true, default: Date.now },
    notes: String,
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

expenseSchema.index({ organizationId: 1, referenceNumber: 1 }, { unique: true });
expenseSchema.index({ organizationId: 1, spentAt: -1 });

export const Expense = tenantModel<IExpense>('Expense', expenseSchema);
