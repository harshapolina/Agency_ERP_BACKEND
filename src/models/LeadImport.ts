import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type ImportStatus = 'pending' | 'mapping' | 'previewing' | 'processing' | 'completed' | 'failed';
export type ImportSource = 'csv' | 'excel' | 'manual' | 'bulk_text' | 'google_sheets' | 'api';

export interface ILeadImport extends Document {
  organizationId: Types.ObjectId;
  categoryId: Types.ObjectId;
  fileName?: string;
  source: ImportSource;
  status: ImportStatus;
  fieldMapping: Record<string, string>;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  mergedCount: number;
  errorCount: number;
  importErrors: Array<{ row: number; message: string }>;
  preview: Record<string, unknown>[];
  duplicateStrategy: 'skip' | 'merge' | 'import_all';
  createdBy: Types.ObjectId;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const leadImportSchema = new Schema<ILeadImport>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'LeadCategory', required: true },
    fileName: String,
    source: { type: String, enum: ['csv', 'excel', 'manual', 'bulk_text', 'google_sheets', 'api'], required: true },
    status: { type: String, enum: ['pending', 'mapping', 'previewing', 'processing', 'completed', 'failed'], default: 'pending' },
    fieldMapping: { type: Schema.Types.Mixed, default: {} },
    totalRows: { type: Number, default: 0 },
    importedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    mergedCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    importErrors: [{ row: Number, message: String }],
    preview: [Schema.Types.Mixed],
    duplicateStrategy: { type: String, enum: ['skip', 'merge', 'import_all'], default: 'skip' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    completedAt: Date,
  },
  { timestamps: true }
);

export const LeadImport = tenantModel<ILeadImport>('LeadImport', leadImportSchema);
