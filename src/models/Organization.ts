import mongoose, { Schema, Document } from 'mongoose';
import type { SubscriptionPlan } from '../shared/constants/plans.js';
import { COMPANY_PROFILE_FIELDS, NOTIFICATION_CATEGORIES, type CompanyProfileField, type NotificationCategory } from '../shared/constants/os.js';

export interface IOrganization extends Document {
  name: string;
  slug: string;
  logo?: string;
  website?: string;
  industry?: string;
  subscriptionPlan: SubscriptionPlan;
  maxUsers: number;
  planStartedAt?: Date;
  planExpiresAt?: Date;
  settings: {
    timezone: string;
    currency: string;
    dateFormat: string;
    fiscalYearStart: number;
  };
  profile?: Partial<Record<CompanyProfileField, string>>;
  notificationEmails?: Partial<Record<NotificationCategory, string[]>>;
  database?: {
    enabled: boolean;
    uriCipher?: string;
    uriIv?: string;
    uriTag?: string;
    dbName?: string;
    hint?: string;
    status?: 'unconfigured' | 'connected' | 'error';
    lastCheckedAt?: Date;
    lastError?: string;
    updatedBy?: string;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    logo: String,
    website: String,
    industry: String,
    subscriptionPlan: { type: String, enum: ['starter', 'professional', 'enterprise'], default: 'starter' },
    maxUsers: { type: Number, default: 5 },
    planStartedAt: Date,
    planExpiresAt: Date,
    settings: {
      timezone: { type: String, default: 'Asia/Kolkata' },
      currency: { type: String, default: 'INR' },
      dateFormat: { type: String, default: 'DD/MM/YYYY' },
      fiscalYearStart: { type: Number, default: 4 },
    },
    profile: Object.fromEntries(COMPANY_PROFILE_FIELDS.map((f) => [f, { type: String, default: '' }])),
    notificationEmails: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, { type: [String], default: [] }])),
    database: {
      enabled: { type: Boolean, default: false },
      uriCipher: { type: String, select: false },
      uriIv: { type: String, select: false },
      uriTag: { type: String, select: false },
      dbName: { type: String, default: '' },
      hint: { type: String, default: '' },
      status: { type: String, enum: ['unconfigured', 'connected', 'error'], default: 'unconfigured' },
      lastCheckedAt: Date,
      lastError: { type: String, default: '' },
      updatedBy: { type: String, default: '' },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Organization = mongoose.model<IOrganization>('Organization', organizationSchema);
