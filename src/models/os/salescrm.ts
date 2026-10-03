import { Schema } from 'mongoose';
import { osModel, osSchema, ref, str, oneOf } from './base.js';
import {
  SALES_EMPLOYEE_STATUSES, SALES_LEAD_SOURCES, SALES_LEAD_TEMPERATURES, SALES_LEAD_STATUSES,
  SALES_DEAL_STAGES, SALES_LOST_REASONS, SALES_CALL_OUTCOMES, SALES_MEETING_TYPES, SALES_MEETING_STATUSES,
  SALES_FOLLOWUP_TYPES, SALES_FOLLOWUP_STATUSES, SALES_QUOTATION_STATUSES, SALES_PROPOSAL_STATUSES,
  SALES_CALL_STATUSES, SALES_CALL_CHANNELS, SALES_CALL_PROVIDERS, SALES_CALL_DURATION_SOURCES,
  SALES_TASK_STATUSES, SALES_APPROVAL_TYPES, SALES_APPROVAL_STATUSES, SALES_ATTENDANCE_STATUSES,
  SALES_TARGET_PERIODS, SALES_TERRITORY_TYPES, LEAD_PRIORITIES,
} from '../../shared/constants/os.js';

const employeeSchema = osSchema({
  userId: ref('User', { required: true }),
  employeeCode: str(),
  isSalesAdmin: { type: Boolean, default: false, index: true },
  department: str({ default: 'Sales' }),
  team: str(),
  territory: str(),
  status: oneOf(SALES_EMPLOYEE_STATUSES, 'active', { index: true }),
  phone: str(),
  joinedAt: { type: Date, default: Date.now },
  moduleOverrides: { type: Object, default: {} },
});
employeeSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
export const SalesEmployee = osModel('SalesEmployee', employeeSchema);

const leadSchema = osSchema({
  company: str({ index: true }),
  contactPerson: { type: String, required: true, trim: true },
  phone: str({ index: true }),
  email: str({ lowercase: true, index: true }),
  website: str(),
  city: str(),
  state: str(),
  country: str(),
  source: oneOf(SALES_LEAD_SOURCES, 'website'),
  campaign: str(),
  industry: str(),
  requirement: str(),
  priority: oneOf(LEAD_PRIORITIES, 'medium'),
  temperature: oneOf(SALES_LEAD_TEMPERATURES, 'warm'),
  status: oneOf(SALES_LEAD_STATUSES, 'new', { index: true }),
  assignedEmployeeId: ref('SalesEmployee', { index: true }),
  territory: str(),
  lastContactedAt: Date,
  nextFollowUpAt: Date,
  notes: str(),
  tags: { type: [String], default: [] },
  qualificationNotes: str(),
  budget: { type: Number, default: 0 },
  timeline: str(),
  decisionMaker: str(),
  businessNeed: str(),
  probability: { type: Number, default: 0, min: 0, max: 100 },
  nextAction: str(),
});
export const SalesLead = osModel('SalesLead', leadSchema);

const dealSchema = osSchema({
  dealName: { type: String, required: true, trim: true },
  leadId: ref('SalesLead'),
  customerId: ref('SalesCustomer'),
  value: { type: Number, default: 0 },
  probability: { type: Number, default: 10, min: 0, max: 100 },
  stage: oneOf(SALES_DEAL_STAGES, 'new', { index: true }),
  ownerEmployeeId: ref('SalesEmployee', { index: true }),
  priority: oneOf(LEAD_PRIORITIES, 'medium'),
  source: str(),
  expectedCloseDate: Date,
  lastActivityAt: Date,
  nextFollowUpAt: Date,
  notes: str(),
  currentOffer: { type: Number, default: 0 },
  finalOffer: { type: Number, default: 0 },
  discountRequested: { type: Number, default: 0 },
  discountApproved: { type: Number, default: 0 },
  competitor: str(),
  closedAt: Date,
  paymentStatus: str(),
  lostReason: { type: String, enum: [...SALES_LOST_REASONS, ''], default: '' },
  lostNotes: str(),
});
export const SalesDeal = osModel('SalesDeal', dealSchema);

const customerSchema = osSchema({
  name: { type: String, required: true, trim: true },
  company: str(),
  industry: str(),
  city: str(),
  email: str({ lowercase: true }),
  phone: str(),
  ownerEmployeeId: ref('SalesEmployee', { index: true }),
  sourceLeadId: ref('SalesLead'),
  customerSince: { type: Date, default: Date.now },
  totalRevenue: { type: Number, default: 0 },
  notes: str(),
});
export const SalesCustomer = osModel('SalesCustomer', customerSchema);

const callSchema = osSchema({
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  employeeId: ref('SalesEmployee', { required: true, index: true }),
  calledAt: { type: Date, default: Date.now },
  dialedAt: Date,
  endedAt: Date,
  /** Null when the CRM could not time the call. A tel: link never supplies a carrier duration. */
  durationSeconds: { type: Number, default: null },
  durationSource: oneOf(SALES_CALL_DURATION_SOURCES, 'unavailable'),
  durationMinutes: { type: Number, default: 0 },
  outcome: { type: String, enum: [...SALES_CALL_OUTCOMES, ''], default: '' },
  notes: str(),
  nextAction: str(),
  nextFollowUpAt: Date,
  /** E.164 number actually dialed, kept so history stays stable if the lead phone changes. */
  phone: str(),
  status: { type: String, enum: SALES_CALL_STATUSES, index: true },
  channel: { type: String, enum: SALES_CALL_CHANNELS },
  provider: oneOf(SALES_CALL_PROVIDERS, 'device_sim'),
});
callSchema.index({ organizationId: 1, employeeId: 1, status: 1, calledAt: -1 });
export const SalesCall = osModel('SalesCall', callSchema);

/** A signed-in handset that can place SIM calls for this employee. Not a telephony account. */
const phoneLinkSchema = osSchema({
  employeeId: ref('SalesEmployee', { required: true, index: true }),
  userId: ref('User', { required: true }),
  deviceId: { type: String, required: true, trim: true },
  userAgent: str(),
  lastSeenAt: { type: Date, default: Date.now, index: true },
});
phoneLinkSchema.index({ organizationId: 1, employeeId: 1, deviceId: 1 }, { unique: true });
export const SalesPhoneLink = osModel('SalesPhoneLink', phoneLinkSchema);

const meetingSchema = osSchema({
  title: { type: String, required: true, trim: true },
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  ownerEmployeeId: ref('SalesEmployee', { required: true, index: true }),
  participants: str(),
  type: oneOf(SALES_MEETING_TYPES, 'discovery'),
  startsAt: { type: Date, required: true },
  location: str(),
  status: oneOf(SALES_MEETING_STATUSES, 'scheduled', { index: true }),
  agenda: str(),
  notes: str(),
  decisions: str(),
  nextSteps: str(),
});
export const SalesMeeting = osModel('SalesMeeting', meetingSchema);

const followUpSchema = osSchema({
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  ownerEmployeeId: ref('SalesEmployee', { required: true, index: true }),
  type: oneOf(SALES_FOLLOWUP_TYPES, 'call'),
  dueAt: { type: Date, required: true },
  notes: str(),
  priority: oneOf(LEAD_PRIORITIES, 'medium'),
  status: oneOf(SALES_FOLLOWUP_STATUSES, 'pending', { index: true }),
  completedAt: Date,
});
export const SalesFollowUp = osModel('SalesFollowUp', followUpSchema);

const quotationItemSchema = new Schema(
  { name: { type: String, required: true, trim: true }, quantity: { type: Number, default: 1 }, price: { type: Number, default: 0 } },
  { _id: false }
);
const quotationSchema = osSchema({
  quotationNumber: { type: String, required: true },
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  ownerEmployeeId: ref('SalesEmployee', { required: true, index: true }),
  customerName: str(),
  items: { type: [quotationItemSchema], default: [] },
  discountPercent: { type: Number, default: 0 },
  taxPercent: { type: Number, default: 18 },
  subtotal: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  validUntil: Date,
  terms: str(),
  notes: str(),
  status: oneOf(SALES_QUOTATION_STATUSES, 'draft', { index: true }),
  version: { type: Number, default: 1 },
  previousVersionId: ref('SalesQuotation'),
});
quotationSchema.index({ organizationId: 1, quotationNumber: 1 }, { unique: true });
export const SalesQuotation = osModel('SalesQuotation', quotationSchema);

const proposalSchema = osSchema({
  title: { type: String, required: true, trim: true },
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  ownerEmployeeId: ref('SalesEmployee', { required: true, index: true }),
  scope: str(),
  pricing: { type: Number, default: 0 },
  timeline: str(),
  terms: str(),
  status: oneOf(SALES_PROPOSAL_STATUSES, 'draft', { index: true }),
});
export const SalesProposal = osModel('SalesProposal', proposalSchema);

const taskSchema = osSchema({
  title: { type: String, required: true, trim: true },
  description: str(),
  ownerEmployeeId: ref('SalesEmployee', { index: true }),
  priority: oneOf(LEAD_PRIORITIES, 'medium'),
  dueDate: Date,
  status: oneOf(SALES_TASK_STATUSES, 'todo', { index: true }),
  /** When set, this Sales task mirrors an agency Delivery task for the BDA portal. */
  agencyTaskId: str({ index: true }),
});
export const SalesTask = osModel('SalesTask', taskSchema);

const targetSchema = osSchema({
  employeeId: ref('SalesEmployee', { index: true }),
  period: oneOf(SALES_TARGET_PERIODS, 'monthly'),
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  targetValue: { type: Number, default: 0 },
});
export const SalesTarget = osModel('SalesTarget', targetSchema);

const territorySchema = osSchema({
  name: { type: String, required: true, trim: true },
  type: oneOf(SALES_TERRITORY_TYPES, 'custom'),
  description: str(),
});
territorySchema.index({ organizationId: 1, name: 1 }, { unique: true });
export const SalesTerritory = osModel('SalesTerritory', territorySchema);

const approvalSchema = osSchema({
  type: { type: String, enum: SALES_APPROVAL_TYPES, required: true },
  dealId: ref('SalesDeal'),
  requesterEmployeeId: ref('SalesEmployee', { required: true, index: true }),
  reviewerEmployeeId: ref('SalesEmployee'),
  reason: str(),
  requestedValue: str(),
  status: oneOf(SALES_APPROVAL_STATUSES, 'pending', { index: true }),
  reviewerComment: str(),
  decidedAt: Date,
});
export const SalesApproval = osModel('SalesApproval', approvalSchema);

const attendanceSchema = osSchema({
  employeeId: ref('SalesEmployee', { required: true, index: true }),
  date: { type: String, required: true },
  status: oneOf(SALES_ATTENDANCE_STATUSES, 'present'),
  checkInAt: Date,
  checkOutAt: Date,
  notes: str(),
});
attendanceSchema.index({ organizationId: 1, employeeId: 1, date: 1 }, { unique: true });
export const SalesAttendance = osModel('SalesAttendance', attendanceSchema);

const workStatusSchema = osSchema({
  employeeId: ref('SalesEmployee', { required: true, index: true }),
  date: { type: String, required: true },
  summary: str(),
  blockers: str(),
  planTomorrow: str(),
});
workStatusSchema.index({ organizationId: 1, employeeId: 1, date: 1 }, { unique: true });
export const SalesWorkStatus = osModel('SalesWorkStatus', workStatusSchema);

const activitySchema = osSchema({
  type: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  detail: str(),
  actorEmployeeId: ref('SalesEmployee'),
  actorName: str(),
  leadId: ref('SalesLead'),
  dealId: ref('SalesDeal'),
  metadata: { type: Object, default: {} },
});
activitySchema.index({ organizationId: 1, createdAt: -1 });
export const SalesActivityEvent = osModel('SalesActivityEvent', activitySchema);

const messageSchema = osSchema({
  channel: oneOf(['email', 'whatsapp'] as const, 'email', { index: true }),
  direction: oneOf(['outbound', 'inbound'] as const, 'outbound'),
  leadId: ref('SalesLead', { index: true }),
  dealId: ref('SalesDeal'),
  employeeId: ref('SalesEmployee', { required: true, index: true }),
  toAddress: str(),
  subject: str(),
  body: { type: String, required: true, trim: true },
  status: oneOf(['logged', 'sent', 'failed'] as const, 'logged'),
  sentAt: { type: Date, default: Date.now },
});
messageSchema.index({ organizationId: 1, sentAt: -1 });
export const SalesMessage = osModel('SalesMessage', messageSchema);
