import { Schema } from 'mongoose';
import { osModel, osSchema, ref, str, oneOf } from './base.js';
import {
  VAULT_PROJECT_STATUSES, VAULT_MESSAGE_TYPES, PITCH_STATUSES,
  TRACKER_STATUSES, TRACKER_PRIORITIES, TRACKER_KINDS,
} from '../../shared/constants/os.js';

const conversionSchema = osSchema({
  conversionUuid: { type: String, required: true },
  publicCode: { type: String, required: true, uppercase: true },
  leadId: ref('Lead', { index: true }),
  referralId: ref('Referral'),
  vendorId: ref('Vendor'),
  conversionValue: { type: Number, default: 0 },
  services: { type: [String], default: [] },
  expectedStart: Date,
  owner: str(),
  ownerId: ref('User'),
  convertedAt: { type: Date, default: Date.now },
  notes: str(),
  origin: oneOf(['lead_convert', 'direct_client'], 'lead_convert'),
});
conversionSchema.index({ organizationId: 1, conversionUuid: 1 }, { unique: true });
conversionSchema.index({ organizationId: 1, publicCode: 1 }, { unique: true });
export const Conversion = osModel('Conversion', conversionSchema);

const vendorSchema = osSchema({
  conversionUuid: { type: String, required: true },
  conversionId: ref('Conversion', { required: true }),
  companyId: ref('Company', { index: true }),
  primaryContactId: ref('Contact'),
  companyName: { type: String, required: true, trim: true },
  contactPerson: str(),
  email: str({ lowercase: true }),
  phone: str(),
  address: str(),
  location: str(),
  industry: str(),
  gstNumber: str(),
  website: str(),
  socialLinks: str(),
  accountOwner: str(),
  source: str(),
  relationshipStatus: oneOf(['active', 'inactive', 'churned'], 'active'),
  activeStatus: oneOf(['working_on_project', 'active', 'inactive'], 'active'),
  onboardedAt: { type: Date, default: Date.now },
  notes: str(),
});
vendorSchema.index({ organizationId: 1, conversionUuid: 1 }, { unique: true });
vendorSchema.index({ organizationId: 1, companyName: 1 });
vendorSchema.index({ organizationId: 1, email: 1 });
export const Vendor = osModel('Vendor', vendorSchema);

const vaultProjectSchema = osSchema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  localUrl: str(),
  productionUrl: str(),
  loginEmail: str({ lowercase: true }),
  passwordCipher: str(),
  passwordIv: str(),
  passwordTag: str(),
  description: str(),
  category: str({ index: true }),
  status: oneOf(VAULT_PROJECT_STATUSES, 'active', { index: true }),
  targetIndustry: str(),
  idealCustomer: str(),
  sellingPoints: str(),
  commonObjections: str(),
  bestPitchAngle: str(),
  pricingNotes: str(),
  competitors: str(),
  demoNotes: str(),
  internalNotes: str(),
});
vaultProjectSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const VaultProject = osModel('VaultProject', vaultProjectSchema);

const vaultMessageSchema = osSchema({
  projectId: ref('VaultProject', { required: true, index: true }),
  type: { type: String, enum: VAULT_MESSAGE_TYPES, required: true },
  subject: str(),
  body: str(),
});
vaultMessageSchema.index({ organizationId: 1, projectId: 1, type: 1 }, { unique: true });
export const VaultProjectMessage = osModel('VaultProjectMessage', vaultMessageSchema);

const pitchSchema = osSchema({
  leadId: ref('Lead', { required: true, index: true }),
  projectId: ref('VaultProject', { required: true, index: true }),
  projectName: str(),
  pitchedBy: str(),
  pitchedAt: { type: Date, default: Date.now },
  status: oneOf(PITCH_STATUSES, 'pitched', { index: true }),
  notes: str(),
  attemptCount: { type: Number, default: 1 },
});
pitchSchema.index(
  { organizationId: 1, leadId: 1, projectId: 1 },
  { unique: true, partialFilterExpression: { recordStatus: 'active' } }
);
export const LeadProjectPitch = osModel('LeadProjectPitch', pitchSchema);

const credentialSchema = osSchema({
  productName: { type: String, required: true, trim: true, index: true },
  category: str({ index: true }),
  url: str(),
  username: str(),
  passwordCipher: str(),
  passwordIv: str(),
  passwordTag: str(),
  notes: str(),
});
export const ProductCredential = osModel('ProductCredential', credentialSchema);

const historyEntrySchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    byEmail: str(),
    byName: str(),
    field: str(),
    from: str(),
    to: str(),
  },
  { _id: false }
);

const trackerRowSchema = osSchema({
  date: { type: Date, required: true, index: true },
  projectName: { type: String, required: true, trim: true },
  taskName: { type: String, required: true, trim: true },
  dependency: { type: [String], default: [] },
  poc: str(),
  pocUserId: ref('User'),
  status: oneOf(TRACKER_STATUSES, 'not_yet_started', { index: true }),
  remarks: str(),
  priority: oneOf(TRACKER_PRIORITIES, 'medium'),
  kind: oneOf(TRACKER_KINDS, 'deadline', { index: true }),
  deadline: Date,
  completedAt: Date,
  history: { type: [historyEntrySchema], default: [] },
});
export const TrackerRow = osModel('TrackerRow', trackerRowSchema);

const trackerCheckInSchema = osSchema({
  userId: ref('User'),
  email: { type: String, required: true, lowercase: true, index: true },
  name: str(),
  dayKey: { type: String, required: true, index: true },
  checkedInAt: { type: Date, required: true },
});
trackerCheckInSchema.index({ organizationId: 1, email: 1, dayKey: 1 }, { unique: true });
export const TrackerCheckIn = osModel('TrackerCheckIn', trackerCheckInSchema);
