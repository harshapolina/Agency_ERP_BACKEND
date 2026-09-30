import { Schema } from 'mongoose';
import { osModel, osSchema, ref, str, oneOf } from './base.js';
import {
  TRANSACTION_TYPES, TRANSACTION_PAYMENT_METHODS, TRANSACTION_HISTORY_ACTIONS,
  RECURRING_PAYMENT_FREQUENCIES, RECURRING_PAYMENT_STATUSES,
} from '../../shared/constants/os.js';

const paymentSchema = osSchema({
  conversionUuid: str({ index: true }),
  invoiceId: ref('Invoice', { required: true, index: true }),
  projectId: ref('Project'),
  vendorId: ref('Vendor'),
  amount: { type: Number, required: true, min: 0 },
  paidAt: { type: Date, default: Date.now },
  method: str({ default: 'bank' }),
  reference: str(),
  notes: str(),
});
export const Payment = osModel('Payment', paymentSchema);

const historySchema = new Schema(
  {
    action: { type: String, enum: TRANSACTION_HISTORY_ACTIONS, required: true },
    changes: {
      type: [new Schema({ field: { type: String, required: true }, from: str(), to: str() }, { _id: false })],
      default: [],
    },
    by: str(),
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const transactionSchema = osSchema({
  type: { type: String, enum: TRANSACTION_TYPES, required: true, index: true },
  title: { type: String, required: true, trim: true },
  category: str(),
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, required: true, index: true },
  party: str(),
  paymentMethod: oneOf(TRANSACTION_PAYMENT_METHODS, 'upi'),
  reference: str(),
  notes: str(),
  history: { type: [historySchema], default: [] },
});
transactionSchema.index({ organizationId: 1, recordStatus: 1, date: -1 });
export const Transaction = osModel('Transaction', transactionSchema);

const recurringSchema = osSchema({
  title: { type: String, required: true, trim: true },
  payee: str(),
  amount: { type: Number, required: true, min: 0 },
  frequency: oneOf(RECURRING_PAYMENT_FREQUENCIES, 'monthly', { index: true }),
  nextDueAt: { type: Date, required: true, index: true },
  lastPaidAt: Date,
  lastRemindedAt: Date,
  notes: str(),
  status: oneOf(RECURRING_PAYMENT_STATUSES, 'active', { index: true }),
});
export const RecurringPayment = osModel('RecurringPayment', recurringSchema);

const manualRevenueSchema = osSchema({
  source: { type: String, required: true, trim: true },
  description: str(),
  amount: { type: Number, required: true },
  receivedAt: { type: Date, default: Date.now, index: true },
  projectId: ref('Project'),
  vendorId: ref('Vendor'),
  paymentMethod: str(),
  reference: str(),
  notes: str(),
  history: { type: [historySchema], default: [] },
});
export const ManualRevenue = osModel('ManualRevenue', manualRevenueSchema);
