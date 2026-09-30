import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export interface IContact extends Document {
  organizationId: Types.ObjectId;
  companyId?: Types.ObjectId;
  leadId?: Types.ObjectId;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  isPrimary: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<IContact>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    firstName: { type: String, required: true, trim: true },
    lastName: String,
    email: { type: String, lowercase: true },
    phone: String,
    title: String,
    isPrimary: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const Contact = tenantModel<IContact>('Contact', contactSchema);
