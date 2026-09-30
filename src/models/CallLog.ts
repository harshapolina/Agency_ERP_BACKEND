import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type CallOutcome =
  | 'connected' | 'busy' | 'no_answer' | 'switched_off'
  | 'call_back' | 'interested' | 'meeting' | 'proposal' | 'won' | 'lost';

export interface ICallLog extends Document {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  callerId: Types.ObjectId;
  outcome: CallOutcome;
  duration: number;
  notes?: string;
  scriptUsed?: string;
  recordingUrl?: string;
  scheduledCallback?: Date;
  createdAt: Date;
}

const callLogSchema = new Schema<ICallLog>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  outcome: {
    type: String,
    enum: ['connected', 'busy', 'no_answer', 'switched_off', 'call_back', 'interested', 'meeting', 'proposal', 'won', 'lost'],
    required: true,
  },
  duration: { type: Number, default: 0 },
  notes: String,
  scriptUsed: String,
  recordingUrl: String,
  scheduledCallback: Date,
  createdAt: { type: Date, default: Date.now, index: true },
});

callLogSchema.index({ organizationId: 1, callerId: 1, createdAt: -1 });

export const CallLog = tenantModel<ICallLog>('CallLog', callLogSchema);
