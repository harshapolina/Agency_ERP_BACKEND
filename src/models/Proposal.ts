import mongoose, { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';

export type ProposalStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired';

export interface IProposal extends Document {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  title: string;
  description?: string;
  items: Array<{ description: string; quantity: number; rate: number; amount: number }>;
  subtotal: number;
  taxAmount: number;
  total: number;
  currency: string;
  status: ProposalStatus;
  validUntil?: Date;
  sentAt?: Date;
  viewedAt?: Date;
  acceptedAt?: Date;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const proposalSchema = new Schema<IProposal>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    title: { type: String, required: true },
    description: String,
    items: [{
      description: { type: String, required: true },
      quantity: { type: Number, default: 1 },
      rate: { type: Number, required: true },
      amount: { type: Number, required: true },
    }],
    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'], default: 'draft' },
    validUntil: Date,
    sentAt: Date,
    viewedAt: Date,
    acceptedAt: Date,
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const Proposal = tenantModel<IProposal>('Proposal', proposalSchema);
