import { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';
import { INVOICE_STATUSES, RECORD_STATUSES, DEFAULT_TAX_RATE, DEFAULT_HSN_SAC } from '../shared/constants/os.js';

export interface IInvoiceLineItem {
  description: string;
  specifications?: string;
  hsnSac?: string;
  quantity: number;
  uom?: string;
  unitPrice: number;
  discountPercent?: number;
}

export interface IInvoice extends Document {
  organizationId: Types.ObjectId;
  invoiceUuid: string;
  invoiceNumber: string;
  conversionUuid?: string;
  projectId?: Types.ObjectId;
  vendorId?: Types.ObjectId;
  clientId?: Types.ObjectId;
  leadId?: Types.ObjectId;
  issueDate: Date;
  dueDate?: Date;
  lineItems: IInvoiceLineItem[];
  items: Array<{ description: string; quantity: number; rate: number; amount: number; taxRate?: number }>;
  taxRate: number;
  isInterState: boolean;
  overallDiscount: number;
  discount: number;
  subtotal: number;
  taxable: number;
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  total: number;
  amountPaid: number;
  currency: string;
  status: string;
  paidAt?: Date;
  paymentDate?: Date;
  paymentReference?: string;
  documentNote?: string;
  remarks?: string;
  notes?: string;
  state: string;
  stateCode: string;
  placeOfSupply: string;
  buyerRefNo?: string;
  paymentTerms: string;
  billToName?: string;
  billToAddress?: string;
  billToEmail?: string;
  billToPhone?: string;
  billToGst?: string;
  billToPan?: string;
  billToState: string;
  billToStateCode: string;
  shipToName?: string;
  shipToAddress?: string;
  shipToGst?: string;
  shipToState: string;
  shipToStateCode: string;
  recordStatus: string;
  createdBy?: Types.ObjectId;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<IInvoiceLineItem>(
  {
    description: { type: String, required: true },
    specifications: { type: String, default: '' },
    hsnSac: { type: String, default: DEFAULT_HSN_SAC },
    quantity: { type: Number, default: 1 },
    uom: { type: String, default: 'Nos' },
    unitPrice: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
  },
  { _id: false }
);

const invoiceSchema = new Schema<IInvoice>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    invoiceUuid: { type: String, required: true, index: true },
    invoiceNumber: { type: String, required: true },
    conversionUuid: { type: String, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    clientId: { type: Schema.Types.ObjectId, ref: 'User' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    issueDate: { type: Date, default: Date.now },
    dueDate: Date,
    lineItems: { type: [lineItemSchema], default: [] },
    items: [{ description: String, quantity: Number, rate: Number, amount: Number, taxRate: Number }],
    taxRate: { type: Number, default: DEFAULT_TAX_RATE },
    isInterState: { type: Boolean, default: false },
    overallDiscount: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    cgstAmount: { type: Number, default: 0 },
    sgstAmount: { type: Number, default: 0 },
    igstAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: [...INVOICE_STATUSES, 'sent'], default: 'draft' },
    paidAt: Date,
    paymentDate: Date,
    paymentReference: { type: String, default: '' },
    documentNote: { type: String, default: '' },
    remarks: { type: String, default: '' },
    notes: String,
    state: { type: String, default: 'Karnataka' },
    stateCode: { type: String, default: '29' },
    placeOfSupply: { type: String, default: 'Karnataka' },
    buyerRefNo: { type: String, default: '' },
    paymentTerms: { type: String, default: '100% Advance' },
    billToName: { type: String, default: '' },
    billToAddress: { type: String, default: '' },
    billToEmail: { type: String, default: '' },
    billToPhone: { type: String, default: '' },
    billToGst: { type: String, default: '' },
    billToPan: { type: String, default: '' },
    billToState: { type: String, default: 'Karnataka' },
    billToStateCode: { type: String, default: '29' },
    shipToName: { type: String, default: '' },
    shipToAddress: { type: String, default: '' },
    shipToGst: { type: String, default: '' },
    shipToState: { type: String, default: 'Karnataka' },
    shipToStateCode: { type: String, default: '29' },
    recordStatus: { type: String, enum: RECORD_STATUSES, default: 'active', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

invoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });

export const Invoice = tenantModel<IInvoice>('Invoice', invoiceSchema);
