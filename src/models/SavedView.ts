import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface ISavedView extends Document {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId;
  filters: Record<string, unknown>;
  columns: string[];
  sort?: { field: string; order: 'asc' | 'desc' };
  isDefault: boolean;
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const savedViewSchema = new Schema<ISavedView>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'LeadCategory' },
    filters: { type: Schema.Types.Mixed, default: {} },
    columns: [String],
    sort: { field: String, order: { type: String, enum: ['asc', 'desc'] } },
    isDefault: { type: Boolean, default: false },
    isShared: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const SavedView = tenantModel<ISavedView>('SavedView', savedViewSchema);
