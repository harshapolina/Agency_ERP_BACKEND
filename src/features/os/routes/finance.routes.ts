import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  Invoice, Payment, Project, Vendor, Conversion, Transaction, RecurringPayment, ManualRevenue, SalesDeal, User,
  nextSequence,
} from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { route, parseBody, oid, isObjectId, escapeRegex } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity, notifyStaff, writeAudit, type Actor } from '../../../shared/os/activity.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import {
  invoiceTotals, displayInvoiceStatus, withDisplayStatus, advanceDueDate, numberToWordsINR,
} from '../../../shared/os/money.js';
import {
  DEFAULT_TAX_RATE, DEFAULT_HSN_SAC, TRANSACTION_TYPES, TRANSACTION_PAYMENT_METHODS, RECURRING_PAYMENT_FREQUENCIES,
  RECURRING_PAYMENT_STATUSES,
} from '../../../shared/constants/os.js';
import { sendNotificationEmail, sendMail, renderNotificationEmail } from '../../../shared/utils/mailer.js';
import { ensurePortalActive } from '../services/portal.service.js';
import { COMPANY_SELECT, companyProfile, loadCompany, notificationRecipients } from '../../../shared/os/company.js';
import { Organization } from '../../../models/Organization.js';
import type { OsDoc } from '../../../models/os/base.js';

const inr = (n: number) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
const fmtDate = (d?: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function sendFinanceAlert(input: { title: string; lines: [string, unknown][]; actor: Actor; changes?: { field: string; from: string; to: string }[]; eyebrow: string; href: string }) {
  const to = await notificationRecipients(input.actor.organizationId, 'finance');
  if (!to.length) return;
  const lines = input.lines.filter(([, v]) => v !== undefined && v !== null && String(v) !== '').map(([k, v]) => `${k}: ${v}`);
  if (input.changes?.length) lines.push(...input.changes.map((c) => `Changed ${c.field}: ${c.from || '—'} → ${c.to || '—'}`));
  lines.push(`By ${input.actor.name || input.actor.email}`);
  await sendNotificationEmail(to, { title: input.title, eyebrow: input.eyebrow, href: input.href, lines }, input.title, { organizationId: input.actor.organizationId });
}

// ---------------------------------------------------------------- invoices
const lineItemSchema = z.object({
  description: z.string().default(''),
  specifications: z.string().optional(),
  hsnSac: z.string().optional(),
  quantity: z.coerce.number().optional(),
  uom: z.string().optional(),
  unitPrice: z.coerce.number().optional(),
  discountPercent: z.coerce.number().optional(),
});

const detailFields = {
  issueDate: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  state: z.string().optional(),
  stateCode: z.string().optional(),
  placeOfSupply: z.string().optional(),
  buyerRefNo: z.string().optional(),
  paymentTerms: z.string().optional(),
  billToName: z.string().optional(),
  billToAddress: z.string().optional(),
  billToEmail: z.string().optional(),
  billToPhone: z.string().optional(),
  billToGst: z.string().optional(),
  billToPan: z.string().optional(),
  billToState: z.string().optional(),
  billToStateCode: z.string().optional(),
  shipToName: z.string().optional(),
  shipToAddress: z.string().optional(),
  shipToGst: z.string().optional(),
  shipToState: z.string().optional(),
  shipToStateCode: z.string().optional(),
  remarks: z.string().optional(),
  documentNote: z.string().optional(),
};

const invoiceSchema = z.object({
  projectId: z.string().min(1, 'Select a project'),
  lineItems: z.array(lineItemSchema),
  taxRate: z.coerce.number().min(0).max(1).optional(),
  overallDiscount: z.coerce.number().min(0).optional(),
  isInterState: z.boolean().optional(),
  status: z.enum(['draft', 'issued', 'cancelled']).optional(),
  reason: z.string().optional(),
  ...detailFields,
});
type InvoiceInput = z.infer<typeof invoiceSchema>;

function cleanLineItems(items: InvoiceInput['lineItems']) {
  return items
    .map((i) => ({
      description: (i.description || '').trim(),
      specifications: (i.specifications || '').trim(),
      hsnSac: (i.hsnSac || DEFAULT_HSN_SAC).trim(),
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      uom: (i.uom || 'Nos').trim(),
      unitPrice: Number(i.unitPrice) || 0,
      discountPercent: Math.max(0, Math.min(100, Number(i.discountPercent) || 0)),
    }))
    .filter((i) => i.description);
}

function detailsFrom(input: Partial<InvoiceInput>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(detailFields)) {
    if (key === 'issueDate' || key === 'dueDate') continue;
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

async function nextInvoiceNumber(organizationId: string) {
  const year = new Date().getFullYear();
  const prefix = `EC-INV-${year}-`;
  const existing = await Invoice.find({ organizationId, invoiceNumber: { $regex: `^${escapeRegex(prefix)}` } }).select('invoiceNumber').lean();
  const floor = existing.reduce((max, i) => Math.max(max, Number(i.invoiceNumber.slice(prefix.length)) || 0), 0);
  const seq = await nextSequence(organizationId, `invoice:${year}`, floor);
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

async function findInvoice(organizationId: string, id: string) {
  if (!isObjectId(id)) throw new NotFoundError('Invoice');
  const invoice = await Invoice.findOne({ _id: id, organizationId, recordStatus: 'active' });
  if (!invoice) throw new NotFoundError('Invoice');
  return invoice;
}

export const invoiceRoutes = Router();
invoiceRoutes.use(authenticate);

invoiceRoutes.get(
  '/',
  authorize('invoices:read'),
  route(async (req) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { organizationId: oid(req.user!.organizationId), recordStatus: 'active' };
    if (q.projectId && isObjectId(q.projectId)) filter.projectId = oid(q.projectId);
    if (q.conversionUuid) filter.conversionUuid = q.conversionUuid;
    if (q.search?.trim()) {
      const rx = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
      filter.$or = [{ invoiceNumber: rx }, { billToName: rx }];
    }
    const rows = await Invoice.find(filter).populate('projectId', 'name').sort({ createdAt: -1 }).limit(500).lean();
    const data = rows.map((r) => withDisplayStatus(r));
    return q.status && q.status !== 'all' ? data.filter((r) => r.displayStatus === q.status) : data;
  })
);

invoiceRoutes.get(
  '/projects',
  authorize('invoices:write'),
  route(async (req) => {
    const orgId = req.user!.organizationId;
    const projects = await Project.find({ organizationId: orgId, recordStatus: { $ne: 'archived' } }).select('name conversionUuid vendorId').sort({ name: 1 }).lean();
    const vendors = await Vendor.find({ _id: { $in: projects.map((p) => p.vendorId).filter(Boolean) } }).lean();
    const conversions = await Conversion.find({ organizationId: orgId, conversionUuid: { $in: projects.map((p) => p.conversionUuid).filter(Boolean) } }).select('conversionUuid publicCode').lean();
    return projects.map((p) => {
      const v = vendors.find((x) => String(x._id) === String(p.vendorId));
      const c = conversions.find((x) => x.conversionUuid === p.conversionUuid);
      return {
        id: String(p._id), name: p.name, code: c?.publicCode || '',
        billTo: { name: v?.companyName || '', address: v?.address || '', email: v?.email || '', phone: v?.phone || '', gst: v?.gstNumber || '' },
      };
    });
  })
);

invoiceRoutes.get(
  '/company',
  authorize('invoices:read'),
  route(async (req) => {
    return companyProfile(await loadCompany(req.user!.organizationId));
  })
);

invoiceRoutes.get(
  '/:id',
  authorize('invoices:read'),
  route(async (req) => {
    if (!isObjectId(req.params.id)) throw new NotFoundError('Invoice');
    const invoice = await Invoice.findOne({ _id: req.params.id, organizationId: req.user!.organizationId }).populate('projectId', 'name').lean();
    if (!invoice) throw new NotFoundError('Invoice');
    const [payments, vendor, org] = await Promise.all([
      Payment.find({ invoiceId: invoice._id, recordStatus: 'active' }).sort({ paidAt: -1 }).lean(),
      invoice.vendorId ? Vendor.findById(invoice.vendorId).select('companyName email').lean() : null,
      Organization.findById(req.user!.organizationId).select(COMPANY_SELECT).lean(),
    ]);
    return { invoice: withDisplayStatus(invoice), payments, vendor, company: companyProfile(org), amountInWords: numberToWordsINR(invoice.total) };
  })
);

invoiceRoutes.post(
  '/',
  authorize('invoices:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<InvoiceInput>(invoiceSchema, req.body);
    const project = isObjectId(input.projectId) ? await Project.findOne({ _id: input.projectId, organizationId: actor.organizationId }).lean() : null;
    if (!project) throw new ValidationError('Project not found');
    const lineItems = cleanLineItems(input.lineItems);
    if (!lineItems.length) throw new ValidationError('Add at least one line item');
    const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;
    const overallDiscount = input.overallDiscount ?? 0;
    const isInterState = Boolean(input.isInterState);
    const totals = invoiceTotals({ lineItems, taxRate, overallDiscount, isInterState });
    const invoice = await Invoice.create({
      organizationId: actor.organizationId,
      conversionUuid: project.conversionUuid,
      invoiceUuid: randomUUID(),
      invoiceNumber: await nextInvoiceNumber(actor.organizationId),
      projectId: project._id,
      vendorId: project.vendorId,
      issueDate: input.issueDate ? new Date(input.issueDate) : new Date(),
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      lineItems, taxRate, overallDiscount, isInterState, ...totals,
      status: input.status === 'issued' ? 'issued' : 'draft',
      ...detailsFrom(input),
      createdBy: actor.userId,
      updatedBy: actor.email,
    });
    await logActivity(actor, { title: 'Invoice generated', detail: `${invoice.invoiceNumber} · ${inr(invoice.total)}`, conversionUuid: project.conversionUuid, projectId: String(project._id), entityType: 'invoice', entityId: String(invoice._id) });
    res.status(201);
    return withDisplayStatus(invoice.toObject());
  })
);

invoiceRoutes.patch(
  '/:id',
  authorize('invoices:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const invoice = await findInvoice(actor.organizationId, req.params.id as string);
    if (invoice.status === 'cancelled') throw new ValidationError('Invoice is cancelled');
    const input = parseBody<Partial<InvoiceInput>>(invoiceSchema.partial(), req.body);
    const lineItems = input.lineItems ? cleanLineItems(input.lineItems) : invoice.lineItems.map((i) => ({ ...i }));
    if (!lineItems.length) throw new ValidationError('Add at least one line item');
    const taxRate = input.taxRate ?? invoice.taxRate;
    const overallDiscount = input.overallDiscount ?? invoice.overallDiscount;
    const isInterState = input.isInterState ?? invoice.isInterState;
    const totals = invoiceTotals({ lineItems, taxRate, overallDiscount, isInterState });
    if (invoice.total !== totals.total) {
      if (!input.reason?.trim()) throw new ValidationError('A reason is required when changing invoice amount');
      await writeAudit(actor, { entityType: 'invoice', entityId: String(invoice._id), conversionUuid: invoice.conversionUuid, field: 'total', oldValue: invoice.total, newValue: totals.total, reason: input.reason.trim() });
    }
    Object.assign(invoice, { lineItems, taxRate, overallDiscount, isInterState, ...totals, ...detailsFrom(input), updatedBy: actor.email });
    if (input.issueDate) invoice.issueDate = new Date(input.issueDate);
    if (input.dueDate !== undefined) invoice.dueDate = input.dueDate ? new Date(input.dueDate) : undefined;
    if (input.status) invoice.status = input.status;
    if (invoice.status !== 'draft' && invoice.status !== 'cancelled') {
      invoice.status = displayInvoiceStatus({ status: 'issued', dueDate: invoice.dueDate, amountPaid: invoice.amountPaid, total: invoice.total });
    }
    await invoice.save();
    await logActivity(actor, { title: 'Invoice updated', detail: invoice.invoiceNumber, entityType: 'invoice', entityId: String(invoice._id), projectId: invoice.projectId ? String(invoice.projectId) : undefined });
    return withDisplayStatus(invoice.toObject());
  })
);

invoiceRoutes.post(
  '/:id/share',
  authorize('invoices:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const invoice = await findInvoice(actor.organizationId, req.params.id as string);
    if (invoice.status === 'cancelled') throw new ValidationError('Cannot share a cancelled invoice');
    const vendor = invoice.vendorId ? await Vendor.findById(invoice.vendorId).lean() : null;
    const to = String(req.body?.email || invoice.billToEmail || vendor?.email || '').trim();
    if (!to) throw new ValidationError('No client email on file');
    if (!invoice.conversionUuid) throw new ValidationError('Invoice is not linked to a client');
    if (invoice.status === 'draft') {
      invoice.status = 'issued';
      await invoice.save();
    }
    const portal = await ensurePortalActive(actor, invoice.conversionUuid);
    const clientName = (invoice.billToName || vendor?.companyName || 'there').split(/\s+/)[0];
    const sender = companyProfile(await loadCompany(actor.organizationId)).fromName;
    const html = renderNotificationEmail({
      eyebrow: sender,
      title: `Invoice ${invoice.invoiceNumber}`,
      body: `Hi ${clientName},\n\nYour invoice ${invoice.invoiceNumber} for ${inr(invoice.total)} is ready to view in your client portal.\nYou can open it anytime to track status and download a PDF.`,
      href: `${portal.url}/invoices/${invoice._id}`,
      ctaLabel: 'View invoice',
    });
    const sent = await sendMail(to, `Invoice ${invoice.invoiceNumber} from ${sender}`, html, { organizationId: actor.organizationId });
    if (!sent) throw new ValidationError('Failed to send email — check the SMTP settings');
    await logActivity(actor, { title: 'Invoice shared by email', detail: `${invoice.invoiceNumber} → ${to}`, entityType: 'invoice', entityId: String(invoice._id), conversionUuid: invoice.conversionUuid });
    return { message: `Invoice link sent to ${to}` };
  })
);

invoiceRoutes.delete(
  '/:id',
  authorize('invoices:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const invoice = await findInvoice(actor.organizationId, req.params.id as string);
    invoice.recordStatus = 'archived';
    invoice.updatedBy = actor.email;
    await invoice.save();
    await logActivity(actor, { title: 'Invoice deleted', detail: invoice.invoiceNumber, entityType: 'invoice', entityId: String(invoice._id) });
    return { id: String(invoice._id) };
  })
);

// ---------------------------------------------------------------- payments
const paymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  paidAt: z.string().optional(),
  method: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

const clientPaymentSchema = z.object({
  vendorId: z.string().min(1),
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  paidAt: z.string().optional(),
  method: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

async function afterPayment(actor: Actor, payment: OsDoc, invoiceNumber: string, href: string, body: string) {
  await logActivity(actor, { title: 'Payment recorded', detail: `${inr(payment.amount)} on ${invoiceNumber}`, entityType: 'payment', entityId: String(payment._id), conversionUuid: payment.conversionUuid, projectId: payment.projectId ? String(payment.projectId) : undefined });
  await notifyStaff(actor.organizationId, { type: 'invoice', title: 'Payment received', body, href, recipientRoles: ['finance'], excludeUserId: actor.userId, emailCategory: 'finance' });
}

export const paymentRoutes = Router();
paymentRoutes.use(authenticate);

paymentRoutes.get(
  '/',
  authorize('payments:read'),
  route(async (req) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { organizationId: oid(req.user!.organizationId), recordStatus: 'active' };
    if (q.invoiceId && isObjectId(q.invoiceId)) filter.invoiceId = oid(q.invoiceId);
    if (q.vendorId && isObjectId(q.vendorId)) filter.vendorId = oid(q.vendorId);
    return Payment.find(filter).populate('invoiceId', 'invoiceNumber billToName total').populate('vendorId', 'companyName').sort({ paidAt: -1 }).limit(500).lean();
  })
);

paymentRoutes.post(
  '/',
  authorize('payments:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<z.infer<typeof paymentSchema>>(paymentSchema, req.body);
    const invoice = await findInvoice(actor.organizationId, input.invoiceId);
    if (invoice.status === 'draft' || invoice.status === 'cancelled') throw new ValidationError('Cannot pay a draft or cancelled invoice');
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const payment = await Payment.create({
      organizationId: actor.organizationId, conversionUuid: invoice.conversionUuid, invoiceId: invoice._id, projectId: invoice.projectId, vendorId: invoice.vendorId,
      amount: input.amount, paidAt, method: input.method || 'bank', reference: input.reference || '', notes: input.notes || '',
      createdBy: actor.email, updatedBy: actor.email,
    });
    const prev = invoice.amountPaid || 0;
    invoice.amountPaid = prev + input.amount;
    invoice.paymentDate = paidAt;
    invoice.paymentReference = input.reference || '';
    invoice.status = displayInvoiceStatus({ status: 'issued', dueDate: invoice.dueDate, amountPaid: invoice.amountPaid, total: invoice.total });
    await invoice.save();
    await writeAudit(actor, { entityType: 'invoice', entityId: String(invoice._id), conversionUuid: invoice.conversionUuid, field: 'amountPaid', oldValue: prev, newValue: invoice.amountPaid, reason: input.notes || 'Payment recorded' });
    await afterPayment(actor, payment.toObject(), invoice.invoiceNumber, `/invoices/${invoice._id}`, `${inr(input.amount)} against ${invoice.invoiceNumber}`);
    res.status(201);
    return payment;
  })
);

paymentRoutes.post(
  '/client',
  authorize('payments:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<z.infer<typeof clientPaymentSchema>>(clientPaymentSchema, req.body);
    const vendor = isObjectId(input.vendorId) ? await Vendor.findOne({ _id: input.vendorId, organizationId: actor.organizationId, recordStatus: 'active' }).lean() : null;
    if (!vendor) throw new ValidationError('Client not found');
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const notes = input.notes || 'Client payment';

    let project: OsDoc | null = await Project.findOne({ organizationId: actor.organizationId, conversionUuid: vendor.conversionUuid, recordStatus: { $ne: 'archived' } }).sort({ createdAt: 1 }).lean();
    if (!project) {
      project = (await Project.create({
        organizationId: actor.organizationId, conversionUuid: vendor.conversionUuid, vendorId: vendor._id,
        name: `${vendor.companyName} · Retainer`, description: 'Auto-created for client payments', budget: input.amount,
        status: 'in_progress', createdBy: actor.userId,
      })).toObject();
    }

    const lineItems = [{ description: notes || 'Payment received', specifications: '', hsnSac: DEFAULT_HSN_SAC, quantity: 1, uom: 'Nos', unitPrice: input.amount, discountPercent: 0 }];
    const totals = invoiceTotals({ lineItems, taxRate: 0, overallDiscount: 0 });
    const invoice = await Invoice.create({
      organizationId: actor.organizationId, conversionUuid: vendor.conversionUuid, invoiceUuid: randomUUID(),
      invoiceNumber: await nextInvoiceNumber(actor.organizationId), projectId: project!._id, vendorId: vendor._id,
      issueDate: paidAt, dueDate: paidAt, lineItems, taxRate: 0, overallDiscount: 0, ...totals,
      amountPaid: input.amount, paymentDate: paidAt, paymentReference: input.reference || '', status: 'paid',
      billToName: vendor.companyName, billToEmail: vendor.email, billToPhone: vendor.phone, billToAddress: vendor.address, billToGst: vendor.gstNumber,
      documentNote: 'Logged from client page', createdBy: actor.userId, updatedBy: actor.email,
    });
    const payment = await Payment.create({
      organizationId: actor.organizationId, conversionUuid: vendor.conversionUuid, invoiceId: invoice._id, projectId: project!._id, vendorId: vendor._id,
      amount: input.amount, paidAt, method: input.method || 'bank', reference: input.reference || '', notes, createdBy: actor.email, updatedBy: actor.email,
    });

    if (vendor.conversionUuid) {
      const received = await Invoice.aggregate([
        { $match: { organizationId: oid(actor.organizationId), conversionUuid: vendor.conversionUuid, recordStatus: 'active', status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
      ]);
      const totalReceived = received[0]?.total || 0;
      await Conversion.updateOne({ organizationId: actor.organizationId, conversionUuid: vendor.conversionUuid, conversionValue: { $lt: totalReceived } }, { $set: { conversionValue: totalReceived } });
      await Project.updateOne({ _id: project!._id, budget: { $lt: totalReceived } }, { $set: { budget: totalReceived } });
    }

    await writeAudit(actor, { entityType: 'invoice', entityId: String(invoice._id), conversionUuid: vendor.conversionUuid, field: 'amountPaid', oldValue: 0, newValue: input.amount, reason: notes });
    await afterPayment(actor, payment.toObject(), invoice.invoiceNumber, `/clients/${vendor._id}`, `${inr(input.amount)} from ${vendor.companyName}`);
    res.status(201);
    return { payment, invoice, message: `${inr(input.amount)} added — Received & Revenue updated` };
  })
);

paymentRoutes.delete(
  '/:id',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    if (!isObjectId(req.params.id)) throw new NotFoundError('Payment');
    const payment = await Payment.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' });
    if (!payment) throw new NotFoundError('Payment');
    const invoice = await Invoice.findOne({ _id: payment.invoiceId, recordStatus: 'active' });
    if (invoice) {
      const prev = invoice.amountPaid || 0;
      invoice.amountPaid = Math.max(0, prev - payment.amount);
      invoice.status = invoice.status === 'draft' ? 'draft' : displayInvoiceStatus({ status: 'issued', dueDate: invoice.dueDate, amountPaid: invoice.amountPaid, total: invoice.total });
      await invoice.save();
      await writeAudit(actor, { entityType: 'invoice', entityId: String(invoice._id), conversionUuid: invoice.conversionUuid, field: 'amountPaid', oldValue: prev, newValue: invoice.amountPaid, reason: 'Payment deleted' });
    }
    payment.recordStatus = 'archived';
    payment.updatedBy = actor.email;
    await payment.save();
    await logActivity(actor, { title: 'Payment deleted', detail: inr(payment.amount), entityType: 'payment', entityId: String(payment._id) });
    return { id: String(payment._id) };
  })
);

// ---------------------------------------------------------------- recurring payments
const recurringSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  payee: z.string().optional(),
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  frequency: z.enum(RECURRING_PAYMENT_FREQUENCIES).optional(),
  nextDueAt: z.string().min(1, 'Next due date is required'),
  notes: z.string().optional(),
  status: z.enum(RECURRING_PAYMENT_STATUSES).optional(),
});

async function alertRecurring(actor: Actor, title: string, body: string, entityId: string) {
  await notifyStaff(actor.organizationId, { type: 'recurring_payment', title, body, href: '/recurring-payments', recipientRoles: ['finance', 'admin'], emailCategory: 'finance' });
  await logActivity(actor, { title, detail: body, entityType: 'recurring_payment', entityId });
}

export const recurringPaymentRoutes = Router();
recurringPaymentRoutes.use(authenticate);

recurringPaymentRoutes.get(
  '/',
  authorize('payments:read'),
  route(async (req) => {
    const rows = await RecurringPayment.find({ organizationId: req.user!.organizationId, recordStatus: 'active' }).sort({ nextDueAt: 1 }).lean();
    const now = Date.now();
    const soon = now + 7 * 86_400_000;
    return rows.map((r) => ({ ...r, dueState: r.status !== 'active' ? r.status : new Date(r.nextDueAt).getTime() < now ? 'overdue' : new Date(r.nextDueAt).getTime() <= soon ? 'due_soon' : 'scheduled' }));
  })
);

recurringPaymentRoutes.post(
  '/',
  authorize('payments:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<z.infer<typeof recurringSchema>>(recurringSchema, req.body);
    const row = await RecurringPayment.create({ ...input, frequency: input.frequency || 'monthly', nextDueAt: new Date(input.nextDueAt), status: 'active', organizationId: actor.organizationId, createdBy: actor.email, updatedBy: actor.email });
    await alertRecurring(actor, 'Recurring payment reminder set', `${row.title} · ${inr(row.amount)} · ${row.frequency} · next ${fmtDate(row.nextDueAt)}`, String(row._id));
    res.status(201);
    return row;
  })
);

recurringPaymentRoutes.patch(
  '/:id',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<Partial<z.infer<typeof recurringSchema>>>(recurringSchema.partial(), req.body);
    const row = await RecurringPayment.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' });
    if (!row) throw new NotFoundError('Recurring payment');
    Object.assign(row, { ...input, ...(input.nextDueAt ? { nextDueAt: new Date(input.nextDueAt) } : {}), updatedBy: actor.email });
    await row.save();
    return row;
  })
);

recurringPaymentRoutes.post(
  '/:id/mark-paid',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const row = await RecurringPayment.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' });
    if (!row) throw new NotFoundError('Recurring payment');
    if (row.status !== 'active') throw new ValidationError('Only active recurring payments can be marked paid');
    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    const from = row.nextDueAt && row.nextDueAt > paidAt ? row.nextDueAt : paidAt;
    row.lastPaidAt = paidAt;
    row.nextDueAt = advanceDueDate(from, row.frequency);
    row.updatedBy = actor.email;
    await row.save();
    await alertRecurring(actor, 'Recurring payment marked paid', `${row.title} · ${inr(row.amount)} · next due ${fmtDate(row.nextDueAt)}`, String(row._id));
    return row;
  })
);

recurringPaymentRoutes.post(
  '/reminders',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const rows = await RecurringPayment.find({ organizationId: actor.organizationId, recordStatus: 'active', status: 'active', nextDueAt: { $lte: new Date(Date.now() + 7 * 86_400_000) } }).sort({ nextDueAt: 1 }).lean();
    if (!rows.length) return { message: 'No recurring payments due in the next 7 days' };
    await alertRecurring(actor, `Recurring payment reminders (${rows.length})`, rows.map((r) => `${r.title}: ${inr(r.amount)} due ${fmtDate(r.nextDueAt)}`).join(' · '), String(rows[0]._id));
    await RecurringPayment.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { lastRemindedAt: new Date(), updatedBy: actor.email } });
    return { message: `Sent ${rows.length} reminder(s) to finance` };
  })
);

recurringPaymentRoutes.delete(
  '/:id',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const row = await RecurringPayment.findOneAndUpdate({ _id: req.params.id, organizationId: actor.organizationId }, { $set: { recordStatus: 'archived', status: 'ended', updatedBy: actor.email } });
    if (!row) throw new NotFoundError('Recurring payment');
    return { id: String(row._id) };
  })
);

// ---------------------------------------------------------------- transactions
const transactionSchema = z.object({
  type: z.enum(TRANSACTION_TYPES, { errorMap: () => ({ message: 'Choose income or expense' }) }),
  title: z.string().min(1, 'Title is required'),
  category: z.string().optional(),
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  date: z.string().min(1, 'Date is required'),
  party: z.string().optional(),
  paymentMethod: z.enum(TRANSACTION_PAYMENT_METHODS, { errorMap: () => ({ message: 'Invalid payment method' }) }).optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

function monthRange(month?: string) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  return { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
}

export const transactionRoutes = Router();
transactionRoutes.use(authenticate);

transactionRoutes.get(
  '/',
  authorize('finance:read'),
  route(async (req) => {
    const q = req.query as Record<string, string>;
    const orgId = oid(req.user!.organizationId);
    const range = monthRange(q.month);
    const filter: Record<string, unknown> = { organizationId: orgId, recordStatus: 'active' };
    if (q.type && (TRANSACTION_TYPES as readonly string[]).includes(q.type)) filter.type = q.type;
    if (range) filter.date = range;
    const [rows, manual, invoices] = await Promise.all([
      q.source && q.source !== 'transactions' && q.source !== 'all' ? [] : Transaction.find(filter).sort({ date: -1 }).limit(1000).lean(),
      q.source && q.source !== 'manual' && q.source !== 'all' ? [] : q.type === 'expense' ? [] : ManualRevenue.find({ organizationId: orgId, recordStatus: 'active', ...(range ? { receivedAt: range } : {}) }).sort({ receivedAt: -1 }).lean(),
      q.source && q.source !== 'invoices' && q.source !== 'all' ? [] : q.type === 'expense' ? [] : Payment.find({ organizationId: orgId, recordStatus: 'active', ...(range ? { paidAt: range } : {}) }).populate('invoiceId', 'invoiceNumber billToName').sort({ paidAt: -1 }).lean(),
    ]);
    const ledger = [
      ...rows.map((t) => ({ id: String(t._id), source: 'transactions', type: t.type, title: t.title, category: t.category, amount: t.amount, date: t.date, party: t.party, method: t.paymentMethod, reference: t.reference, notes: t.notes, history: t.history, createdBy: t.createdBy })),
      ...manual.map((m) => ({ id: String(m._id), source: 'manual', type: 'income', title: m.source, category: 'Manual revenue', amount: m.amount, date: m.receivedAt, party: '', method: m.paymentMethod, reference: m.reference, notes: m.notes || m.description, history: m.history, createdBy: m.createdBy })),
      ...invoices.map((p) => {
        const inv = p.invoiceId as unknown as OsDoc | null;
        return { id: String(p._id), source: 'invoices', type: 'income', title: inv?.billToName || 'Invoice payment', category: inv?.invoiceNumber || '', amount: p.amount, date: p.paidAt, party: inv?.billToName || '', method: p.method, reference: p.reference, notes: p.notes, history: [], createdBy: p.createdBy };
      }),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const income = ledger.filter((l) => l.type === 'income').reduce((s, l) => s + l.amount, 0);
    const spent = ledger.filter((l) => l.type === 'expense').reduce((s, l) => s + l.amount, 0);
    return { rows: ledger, totals: { income, spent, net: income - spent } };
  })
);

transactionRoutes.post(
  '/',
  authorize('payments:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<z.infer<typeof transactionSchema>>(transactionSchema, req.body);
    const row = await Transaction.create({
      ...input, paymentMethod: input.paymentMethod || 'upi', date: new Date(input.date), organizationId: actor.organizationId,
      createdBy: actor.email, updatedBy: actor.email, history: [{ action: 'created', changes: [], by: actor.email, at: new Date() }],
    });
    const label = input.type === 'income' ? 'Income' : 'Spent';
    const title = `${label} added: ${input.title} · ${inr(input.amount)}`;
    await logActivity(actor, { title, detail: `${input.category || label} · ${fmtDate(input.date)}`, entityType: 'transaction', entityId: String(row._id) });
    await sendFinanceAlert({
      title, actor, eyebrow: 'Transactions', href: '/transactions',
      lines: [['Type', label], ['Amount', inr(input.amount)], ['Date', fmtDate(input.date)], ['Category', input.category], [input.type === 'income' ? 'Received from' : 'Paid to', input.party], ['Payment method', input.paymentMethod], ['Reference', input.reference], ['Notes', input.notes]],
    });
    res.status(201);
    return row;
  })
);

// ---------------------------------------------------------------- manual revenue
const manualRevenueSchema = z.object({
  source: z.string().min(1, 'Source is required'),
  description: z.string().optional(),
  amount: z.coerce.number().positive('Amount must be a positive number'),
  receivedAt: z.string().min(1, 'Date is required'),
  projectId: z.string().optional(),
  paymentMethod: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});
type ManualInput = z.infer<typeof manualRevenueSchema>;

async function manualSnapshot(row: OsDoc) {
  const project = row.projectId ? await Project.findById(row.projectId).select('name').lean() : null;
  return {
    Source: row.source, Amount: inr(row.amount), 'Received on': fmtDate(row.receivedAt), Project: project?.name || '',
    'Payment method': row.paymentMethod || '', Reference: row.reference || '', Description: row.description || '', Notes: row.notes || '',
  } as Record<string, string>;
}

async function resolveRevenueProject(organizationId: string, projectId?: string) {
  if (!projectId) return { projectId: undefined, vendorId: undefined };
  const project = isObjectId(projectId) ? await Project.findOne({ _id: projectId, organizationId, recordStatus: { $ne: 'archived' } }).lean() : null;
  if (!project) throw new ValidationError('Project not found');
  return { projectId: project._id, vendorId: project.vendorId };
}

export const revenueRoutes = Router();
revenueRoutes.use(authenticate);

revenueRoutes.get(
  '/',
  authorize('finance:read'),
  route(async (req) => {
    const orgId = oid(req.user!.organizationId);
    const [invoices, deals, manual, transactions, projects] = await Promise.all([
      Invoice.find({ organizationId: orgId, recordStatus: 'active', amountPaid: { $gt: 0 } }).select('amountPaid paymentDate billToName createdAt projectId updatedBy invoiceNumber').lean(),
      SalesDeal.find({ organizationId: orgId, stage: 'won', recordStatus: 'active' }).select('dealName value finalOffer closedAt updatedAt updatedBy createdBy').lean(),
      ManualRevenue.find({ organizationId: orgId, recordStatus: 'active' }).sort({ receivedAt: -1 }).lean(),
      Transaction.find({ organizationId: orgId, recordStatus: 'active' }).select('type title category amount date createdBy').lean(),
      Project.find({ organizationId: orgId, recordStatus: { $ne: 'archived' } }).select('name vendorId').sort({ name: 1 }).lean(),
    ]);
    const vendors = await Vendor.find({ _id: { $in: projects.map((p) => p.vendorId).filter(Boolean) } }).select('companyName').lean();
    const projectLabel = (id: unknown) => {
      const p = projects.find((x) => String(x._id) === String(id));
      if (!p) return '';
      const v = vendors.find((x) => String(x._id) === String(p.vendorId));
      return v ? `${p.name} · ${v.companyName}` : p.name;
    };
    const emails = new Set<string>([...deals, ...manual, ...transactions].flatMap((r) => [r.createdBy, r.updatedBy]).filter((e) => typeof e === 'string' && e.includes('@')));
    const staff = await User.find({ email: { $in: [...emails] } }).select('email firstName lastName').lean();
    const nameOf = (e?: string) => {
      if (!e) return '—';
      const u = staff.find((s) => s.email === e);
      return u ? `${u.firstName} ${u.lastName}`.trim() : e;
    };

    const rows = [
      ...invoices.map((i) => ({ id: String(i._id), source: 'Editco OS', label: i.billToName || 'Invoice', detail: [projectLabel(i.projectId), i.invoiceNumber].filter(Boolean).join(' · '), amount: i.amountPaid, date: i.paymentDate || i.createdAt, addedBy: nameOf(i.updatedBy), href: `/invoices/${i._id}` })),
      ...deals.map((d) => ({ id: String(d._id), source: 'Sales CRM', label: d.dealName, detail: '', amount: d.finalOffer || d.value || 0, date: d.closedAt || d.updatedAt, addedBy: nameOf(d.updatedBy || d.createdBy) })),
      ...manual.map((m) => ({ id: String(m._id), source: 'Manual', label: m.source, detail: [projectLabel(m.projectId), m.paymentMethod, m.reference, m.description].filter(Boolean).join(' · '), amount: m.amount, date: m.receivedAt, addedBy: nameOf(m.createdBy), manual: true, history: (m.history || []).map((h: OsDoc) => ({ ...h, by: nameOf(h.by) })), raw: m })),
      ...transactions.map((t) => ({ id: String(t._id), source: t.type === 'income' ? 'Income' : 'Spent', label: t.title, detail: t.category, amount: t.amount, date: t.date, addedBy: nameOf(t.createdBy) })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const sum = (src: string) => rows.filter((r) => r.source === src).reduce((s, r) => s + (r.amount || 0), 0);
    const salesTotal = sum('Sales CRM');
    const osTotal = sum('Editco OS');
    const manualTotal = sum('Manual');
    const incomeTotal = sum('Income');
    const spentTotal = sum('Spent');
    const grandTotal = salesTotal + osTotal + manualTotal + incomeTotal;
    return {
      rows,
      totals: { salesTotal, osTotal, manualTotal, incomeTotal, spentTotal, grandTotal, netProfit: grandTotal - spentTotal },
      projects: projects.map((p) => ({ id: String(p._id), label: projectLabel(p._id) })),
    };
  })
);

revenueRoutes.post(
  '/manual',
  authorize('payments:write'),
  route(async (req, res) => {
    const actor = actorFrom(req.user!);
    const input = parseBody<ManualInput>(manualRevenueSchema, req.body);
    const refs = await resolveRevenueProject(actor.organizationId, input.projectId);
    const row = await ManualRevenue.create({
      ...input, ...refs, receivedAt: new Date(input.receivedAt), organizationId: actor.organizationId, createdBy: actor.email, updatedBy: actor.email,
      history: [{ action: 'created', changes: [], by: actor.email, at: new Date() }],
    });
    const snap = await manualSnapshot(row.toObject());
    const title = `Revenue added: ${input.source} · ${inr(input.amount)}`;
    await logActivity(actor, { title, detail: [snap.Project, snap['Received on']].filter(Boolean).join(' · '), entityType: 'manual_revenue', entityId: String(row._id), projectId: refs.projectId ? String(refs.projectId) : undefined });
    await sendFinanceAlert({ title, actor, eyebrow: 'Revenue', href: '/revenue', lines: Object.entries(snap) });
    res.status(201);
    return row;
  })
);

revenueRoutes.patch(
  '/manual/:id',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const row = await ManualRevenue.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' });
    if (!row) throw new NotFoundError('Revenue entry');
    const input = parseBody<ManualInput>(manualRevenueSchema, req.body);
    const refs = await resolveRevenueProject(actor.organizationId, input.projectId);
    const before = await manualSnapshot(row.toObject());
    const next = { ...row.toObject(), ...input, ...refs, receivedAt: new Date(input.receivedAt) };
    const after = await manualSnapshot(next);
    const changes = Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => ({ field: k, from: before[k], to: after[k] }));
    if (!changes.length) return { message: 'No changes to save', row };
    Object.assign(row, { ...input, projectId: refs.projectId, vendorId: refs.vendorId, receivedAt: new Date(input.receivedAt), updatedBy: actor.email });
    row.history.push({ action: 'updated', changes, by: actor.email, at: new Date() });
    await row.save();
    await logActivity(actor, { title: `Revenue edited: ${row.source}`, detail: changes.map((c) => `${c.field}: ${c.from || '—'} → ${c.to || '—'}`).join(' · '), entityType: 'manual_revenue', entityId: String(row._id) });
    await sendFinanceAlert({ title: `Revenue edited: ${row.source}`, actor, eyebrow: 'Revenue', href: '/revenue', lines: Object.entries(after), changes });
    return { message: 'Revenue entry updated', row };
  })
);

revenueRoutes.delete(
  '/manual/:id',
  authorize('payments:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const row = await ManualRevenue.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' });
    if (!row) throw new NotFoundError('Revenue entry');
    row.recordStatus = 'archived';
    row.history.push({ action: 'deleted', changes: [], by: actor.email, at: new Date() });
    await row.save();
    const title = `Revenue deleted: ${row.source} · ${inr(row.amount)}`;
    await logActivity(actor, { title, entityType: 'manual_revenue', entityId: String(row._id) });
    await sendFinanceAlert({ title, actor, eyebrow: 'Revenue', href: '/revenue', lines: [] });
    return { id: String(row._id) };
  })
);

revenueRoutes.get(
  '/outstanding',
  authorize('finance:read'),
  route(async (req) => {
    const rows = await Invoice.find({ organizationId: req.user!.organizationId, recordStatus: 'active', status: { $nin: ['draft', 'cancelled'] } })
      .populate('projectId', 'name')
      .sort({ dueDate: 1 })
      .lean();
    const now = Date.now();
    const data = rows
      .map((r) => withDisplayStatus(r))
      .filter((r) => r.outstanding > 0)
      .map((r) => ({ ...r, ageDays: r.dueDate ? Math.floor((now - new Date(r.dueDate).getTime()) / 86_400_000) : null }));
    const aging = [
      { label: '0–30 days', min: 0, max: 30 },
      { label: '31–60 days', min: 31, max: 60 },
      { label: '61+ days', min: 61, max: 3650 },
    ].map((b) => ({ label: b.label, amount: data.filter((r) => r.ageDays !== null && r.ageDays >= b.min && r.ageDays <= b.max).reduce((s, r) => s + r.outstanding, 0) }));
    return { rows: data, total: data.reduce((s, r) => s + r.outstanding, 0), overdue: data.filter((r) => r.displayStatus === 'overdue').reduce((s, r) => s + r.outstanding, 0), aging };
  })
);