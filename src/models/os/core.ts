import { osModel, osSchema, ref, str, ObjectId } from './base.js';

const activityEventSchema = osSchema(
  {
    conversionUuid: str({ index: true }),
    leadId: ref('Lead'),
    vendorId: ref('Vendor'),
    projectId: ref('Project', { index: true }),
    entityType: { type: String, required: true },
    entityId: str(),
    title: { type: String, required: true },
    detail: str(),
    actorUserId: ref('User', { index: true }),
    actorName: str(),
    actionType: str({ index: true }),
    metadata: { type: Object, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
activityEventSchema.index({ organizationId: 1, createdAt: -1 });
export const ActivityEvent = osModel('ActivityEvent', activityEventSchema);

const fieldAuditSchema = osSchema(
  {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    conversionUuid: str({ index: true }),
    field: { type: String, required: true },
    oldValue: str(),
    newValue: str(),
    reason: str(),
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
export const FieldAuditLog = osModel('FieldAuditLog', fieldAuditSchema);

const serviceSchema = osSchema({
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
});
serviceSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const ServiceCatalog = osModel('ServiceCatalog', serviceSchema);

const industrySchema = osSchema({
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  sector: str(),
  isActive: { type: Boolean, default: true },
});
industrySchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const IndustryCatalog = osModel('IndustryCatalog', industrySchema);

const reminderLogSchema = osSchema(
  {
    key: { type: String, required: true },
    email: str({ lowercase: true }),
    slot: str(),
    dayKey: str(),
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
reminderLogSchema.index({ organizationId: 1, key: 1 }, { unique: true });
export const ReminderLog = osModel('ReminderLog', reminderLogSchema);

const counterSchema = osSchema({
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ organizationId: 1, key: 1 }, { unique: true });
export const Counter = osModel('Counter', counterSchema);

/** Atomic, per-organization sequence. Fixes the race/lexicographic issues of "find last + 1". */
export async function nextSequence(organizationId: string, key: string, floor = 0): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { organizationId, key },
    [{ $set: { seq: { $add: [{ $max: [{ $ifNull: ['$seq', 0] }, floor] }, 1] }, recordStatus: 'active' } }],
    { new: true, upsert: true }
  ).lean();
  return (doc as unknown as { seq: number }).seq;
}

void ObjectId;
