import { randomUUID } from 'crypto';
import {
  Company, Contact, Conversion, Vendor, Lead, LeadActivity, Project, Invoice, Payment, Meeting,
  OsDocument, ActivityEvent, PortalAccess, Referral, nextSequence,
} from '../../../models/index.js';
import { CONVERSION_CODE_PREFIX, ACTIVE_PROJECT_STATUSES, normalizeProjectStatus } from '../../../shared/constants/os.js';
import { escapeRegex, oid } from '../../../shared/utils/crud.js';
import { logActivity, notifyStaff, type Actor } from '../../../shared/os/activity.js';
import { outstandingOf, withDisplayStatus } from '../../../shared/os/money.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { updateReferralStage } from './referral.service.js';

const exactCi = (value: string) => ({ $regex: `^${escapeRegex(value.trim())}$`, $options: 'i' });

export async function createUniqueConversionIds(organizationId: string) {
  const year = new Date().getFullYear();
  const prefix = `${CONVERSION_CODE_PREFIX}${year}`;
  const existing = await Conversion.find({ organizationId, publicCode: { $regex: `^${prefix}\\d+$` } }).select('publicCode').lean();
  let floor = 0;
  for (const c of existing) {
    const serial = Number(String(c.publicCode).slice(prefix.length));
    if (Number.isFinite(serial) && serial > floor) floor = serial;
  }
  const serial = await nextSequence(organizationId, `conversion:${year}`, floor);
  return { conversionUuid: randomUUID(), publicCode: `${prefix}${String(serial).padStart(3, '0')}` };
}

export async function previewDuplicates(organizationId: string, input: { companyName?: string; email?: string; phone?: string }) {
  const email = (input.email || '').toLowerCase().trim();
  const phone = (input.phone || '').trim();
  const name = (input.companyName || '').trim();
  const org = oid(organizationId);
  const contactOr = [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] as Record<string, string>[];
  const vendorOr = [...contactOr, ...(name ? [{ companyName: exactCi(name) }] : [])];

  const [companies, contacts, vendors] = await Promise.all([
    name ? Company.find({ organizationId: org, name: exactCi(name) }).sort({ updatedAt: -1 }).limit(5).lean() : [],
    contactOr.length ? Contact.find({ organizationId: org, $or: contactOr }).limit(5).lean() : [],
    vendorOr.length ? Vendor.find({ organizationId: org, recordStatus: 'active', $or: vendorOr }).limit(5).lean() : [],
  ]);
  const conversions = vendors.length
    ? await Conversion.find({ _id: { $in: vendors.map((v) => v.conversionId) } }).select('publicCode conversionUuid').lean()
    : [];
  const codeById = new Map(conversions.map((c) => [String(c._id), c]));

  return {
    companies: companies.map((c) => ({ companyId: String(c._id), name: c.name })),
    contacts: contacts.map((c) => ({
      contactId: String(c._id),
      companyId: c.companyId ? String(c.companyId) : '',
      name: [c.firstName, c.lastName].filter(Boolean).join(' '),
      email: c.email || '',
      phone: c.phone || '',
    })),
    vendors: vendors.map((v) => ({
      vendorId: String(v._id),
      companyName: v.companyName,
      email: v.email,
      phone: v.phone,
      publicCode: codeById.get(String(v.conversionId))?.publicCode || '',
      conversionUuid: v.conversionUuid,
    })),
    suggestedMode: vendors.length ? 'use_existing' : 'create_new',
  };
}

interface CompanyInput {
  companyName: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  industry?: string;
  gstNumber?: string;
  website?: string;
}

export async function resolveCompanyAndContact(actor: Actor, input: CompanyInput) {
  const org = oid(actor.organizationId);
  const email = (input.email || '').toLowerCase().trim();
  const phone = (input.phone || '').trim();
  const contactOr = [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] as Record<string, string>[];

  let contact = contactOr.length
    ? await Contact.findOne({ organizationId: org, $or: contactOr }).sort({ updatedAt: -1 })
    : null;
  let companyId = contact?.companyId;

  if (!companyId) {
    const company =
      (await Company.findOne({ organizationId: org, name: exactCi(input.companyName) })) ||
      (await Company.create({ organizationId: org, name: input.companyName, createdBy: actor.userId }));
    companyId = company._id;
  }

  // Only overwrite company fields that were actually supplied (the legacy flow blanked them).
  const companyPatch: Record<string, string> = {};
  for (const key of ['industry', 'website', 'address', 'gstNumber', 'phone', 'email'] as const) {
    const value = key === 'email' ? email : key === 'phone' ? phone : (input[key] || '').trim();
    if (value) companyPatch[key] = value;
  }
  if (Object.keys(companyPatch).length) await Company.updateOne({ _id: companyId }, { $set: companyPatch });

  const [firstName, ...rest] = (input.contactPerson || input.companyName).trim().split(/\s+/);
  if (!contact) {
    contact = await Contact.create({
      organizationId: org, companyId, firstName, lastName: rest.join(' '), email, phone, isPrimary: true, createdBy: actor.userId,
    });
  } else {
    await Contact.updateOne(
      { _id: contact._id },
      { $set: { firstName, lastName: rest.join(' '), isPrimary: true, ...(email && { email }), ...(phone && { phone }) } }
    );
  }
  return { companyId, contactId: contact._id };
}

function inferReferralProjectType(services: string[]) {
  if (services.includes('ai_agent')) return 'ai_growth';
  if (services.includes('crm') || services.includes('automation')) return 'website_crm';
  return 'website';
}

export interface ConvertLeadInput extends Partial<CompanyInput> {
  conversionValue?: number;
  services?: string[];
  expectedStart?: string;
  owner?: string;
  createProject?: boolean;
  projectName?: string;
  forceNew?: boolean;
  selectedVendorId?: string;
  notes?: string;
}

export async function convertLead(actor: Actor, leadId: string, input: ConvertLeadInput) {
  const org = oid(actor.organizationId);
  const lead = await Lead.findOne({ _id: leadId, organizationId: org, isArchived: false });
  if (!lead) throw new NotFoundError('Lead');
  if (lead.status === 'converted' || lead.conversionId) throw new ValidationError('This lead is already converted');

  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  const companyName = (input.companyName || lead.company || leadName).trim();
  const contactPerson = (input.contactPerson || leadName).trim();
  const conversionValue = Number(input.conversionValue ?? lead.estimatedValue ?? 0) || 0;
  const services = input.services?.length ? input.services : lead.interestedServices || [];
  const email = (input.email || lead.email || '').toLowerCase().trim();
  const phone = (input.phone || lead.phone || '').trim();
  const owner = input.owner || actor.name || actor.email;
  const expectedStart = input.expectedStart ? new Date(input.expectedStart) : undefined;
  const details = {
    companyName, contactPerson, email, phone,
    address: input.address || lead.address || '',
    industry: input.industry || lead.industry || '',
    gstNumber: input.gstNumber || '',
    website: input.website || lead.website || '',
  };

  let vendor = null;
  if (!input.forceNew) {
    vendor = input.selectedVendorId
      ? await Vendor.findOne({ _id: input.selectedVendorId, organizationId: org, recordStatus: 'active' })
      : await Vendor.findOne({
          organizationId: org,
          recordStatus: 'active',
          $or: [email && { email }, phone && { phone }, { companyName: exactCi(companyName) }].filter(Boolean) as object[],
        });
  }
  let conversion = vendor ? await Conversion.findOne({ _id: vendor.conversionId, recordStatus: 'active' }) : null;
  const useExisting = Boolean(vendor && conversion && !input.forceNew);

  const { companyId, contactId } = await resolveCompanyAndContact(actor, details);

  if (useExisting && vendor && conversion) {
    await Vendor.updateOne(
      { _id: vendor._id },
      { $set: { ...details, accountOwner: owner, source: lead.source || '', companyId, primaryContactId: contactId, updatedBy: actor.email } }
    );
  } else {
    const ids = await createUniqueConversionIds(actor.organizationId);
    conversion = await Conversion.create({
      organizationId: org, ...ids, leadId: lead._id, referralId: lead.referralId, conversionValue, services, expectedStart,
      owner, ownerId: actor.userId, convertedAt: new Date(), origin: 'lead_convert', notes: input.notes || '',
      createdBy: actor.email, updatedBy: actor.email,
    });
    vendor = await Vendor.create({
      organizationId: org, conversionUuid: ids.conversionUuid, conversionId: conversion._id, companyId, primaryContactId: contactId,
      ...details, accountOwner: owner, source: lead.source || '', onboardedAt: new Date(), createdBy: actor.email, updatedBy: actor.email,
    });
    await Conversion.updateOne({ _id: conversion._id }, { $set: { vendorId: vendor._id } });
  }

  const prevStatus = lead.status;
  await Lead.updateOne(
    { _id: lead._id },
    { $set: { status: 'converted', conversionId: conversion!._id, conversionUuid: conversion!.conversionUuid, company: companyName, companyId, primaryContactId: contactId } }
  );

  let project = null;
  if (input.createProject) {
    project = await Project.create({
      organizationId: org, conversionUuid: conversion!.conversionUuid, conversionId: conversion!._id, vendorId: vendor!._id,
      leadId: lead._id, name: input.projectName || companyName, service: services[0] || '', description: lead.requirement || '',
      startDate: expectedStart, budget: conversionValue, status: 'planned', createdBy: actor.userId,
    });
  }

  await LeadActivity.create({
    organizationId: org, leadId: lead._id, type: 'status_change', title: `Converted · ${conversion!.publicCode}`,
    metadata: { from: prevStatus, to: 'converted', conversionValue }, createdBy: actor.userId,
  });
  const common = { conversionUuid: conversion!.conversionUuid, leadId: String(lead._id), vendorId: String(vendor!._id) };
  await logActivity(actor, {
    ...common, title: useExisting ? 'Lead linked to existing conversion' : 'Lead converted',
    detail: `${conversion!.publicCode} · ${companyName}`, entityType: 'conversion', entityId: String(conversion!._id),
  });
  if (!useExisting) await logActivity(actor, { ...common, title: 'Client relationship created', detail: companyName, entityType: 'vendor', entityId: String(vendor!._id) });
  if (project) await logActivity(actor, { ...common, projectId: String(project._id), title: 'Project created', detail: project.name, entityType: 'project', entityId: String(project._id) });

  await notifyStaff(actor.organizationId, {
    type: 'conversion', title: 'Conversion completed', body: `${companyName} → ${conversion!.publicCode}`,
    href: `/conversions/${conversion!.publicCode}`, entityType: 'conversion', entityId: String(conversion!._id),
    excludeUserId: actor.userId,
  });

  if (lead.referralId) {
    const referral = await Referral.findOne({ _id: lead.referralId, organizationId: org });
    if (referral && referral.stage !== 'won') {
      await updateReferralStage(actor, String(referral._id), {
        stage: 'won', projectType: inferReferralProjectType(conversion!.services || services), projectValue: conversion!.conversionValue,
      }).catch(() => undefined);
    }
  }

  return { publicCode: conversion!.publicCode, conversionUuid: conversion!.conversionUuid, vendorId: String(vendor!._id), projectId: project ? String(project._id) : null, linkedExisting: useExisting };
}

export async function createDirectClient(actor: Actor, input: CompanyInput & { location?: string; socialLinks?: string; accountOwner?: string; notes?: string; services?: string[]; conversionValue?: number }) {
  const org = oid(actor.organizationId);
  if (!input.companyName?.trim()) throw new ValidationError('Company name is required');
  const email = (input.email || '').toLowerCase().trim();
  const phone = (input.phone || '').trim();
  const duplicate = await Vendor.findOne({
    organizationId: org, recordStatus: 'active',
    $or: [email && { email }, phone && { phone }, { companyName: exactCi(input.companyName) }].filter(Boolean) as object[],
  }).lean();
  if (duplicate) throw new ValidationError(`A client with these details already exists (${duplicate.companyName})`);

  const ids = await createUniqueConversionIds(actor.organizationId);
  const conversion = await Conversion.create({
    organizationId: org, ...ids, conversionValue: Number(input.conversionValue) || 0, services: input.services || [],
    owner: input.accountOwner || actor.name || actor.email, ownerId: actor.userId, origin: 'direct_client', createdBy: actor.email, updatedBy: actor.email,
  });
  const { companyId, contactId } = await resolveCompanyAndContact(actor, input);
  const vendor = await Vendor.create({
    organizationId: org, conversionUuid: ids.conversionUuid, conversionId: conversion._id, companyId, primaryContactId: contactId,
    companyName: input.companyName.trim(), contactPerson: input.contactPerson || '', email, phone, address: input.address || '',
    location: input.location || '', industry: input.industry || '', gstNumber: input.gstNumber || '', website: input.website || '',
    socialLinks: input.socialLinks || '', accountOwner: input.accountOwner || actor.name || '', source: 'direct', notes: input.notes || '',
    createdBy: actor.email, updatedBy: actor.email,
  });
  await Conversion.updateOne({ _id: conversion._id }, { $set: { vendorId: vendor._id } });
  await logActivity(actor, {
    conversionUuid: ids.conversionUuid, vendorId: String(vendor._id), title: 'Client added', detail: `${ids.publicCode} · ${vendor.companyName}`,
    entityType: 'vendor', entityId: String(vendor._id),
  });
  return { vendor: vendor.toObject(), publicCode: ids.publicCode };
}

export async function conversionRollup(organizationId: string, conversionUuid: string) {
  const org = oid(organizationId);
  const [projects, invoices] = await Promise.all([
    Project.find({ organizationId: org, conversionUuid, recordStatus: { $ne: 'archived' } }).lean(),
    Invoice.find({ organizationId: org, conversionUuid, recordStatus: 'active', status: { $ne: 'cancelled' } }).lean(),
  ]);
  const contract = projects.reduce((s, p) => s + (p.budget || 0), 0);
  const invoiced = invoices.filter((i) => i.status !== 'draft').reduce((s, i) => s + (i.total || 0), 0);
  const received = invoices.reduce((s, i) => s + (i.amountPaid || 0), 0);
  const statuses = projects.map((p) => normalizeProjectStatus(p.status));
  return {
    contract,
    invoiced,
    received,
    outstanding: outstandingOf(invoiced, received),
    projectCount: projects.length,
    activeProjects: statuses.filter((s) => ACTIVE_PROJECT_STATUSES.includes(s)).length,
    completedProjects: statuses.filter((s) => s === 'completed').length,
    collectedPct: invoiced > 0 ? Math.min(100, Math.round((received / invoiced) * 100)) : 0,
  };
}

export async function conversionHub(organizationId: string, publicCode: string): Promise<Record<string, unknown>> {
  const org = oid(organizationId);
  const conversion = await Conversion.findOne({ organizationId: org, publicCode: publicCode.toUpperCase() }).lean();
  if (!conversion) throw new NotFoundError('Conversion');
  const uuid = conversion.conversionUuid;
  const [vendor, projects, invoices, payments, meetings, documents, activity, portal, lead, rollup] = await Promise.all([
    Vendor.findOne({ organizationId: org, conversionUuid: uuid }).lean(),
    Project.find({ organizationId: org, conversionUuid: uuid, recordStatus: { $ne: 'archived' } }).sort({ createdAt: -1 }).lean(),
    Invoice.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    Payment.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ paidAt: -1 }).lean(),
    Meeting.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ startsAt: -1 }).lean(),
    OsDocument.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
    ActivityEvent.find({ organizationId: org, conversionUuid: uuid }).sort({ createdAt: -1 }).limit(40).lean(),
    PortalAccess.findOne({ organizationId: org, conversionUuid: uuid }).select('isActive tokenHint lastLoginAt createdAt').lean(),
    conversion.leadId ? Lead.findById(conversion.leadId).select('firstName lastName email phone company status').lean() : null,
    conversionRollup(organizationId, uuid),
  ]);
  return {
    conversion,
    vendor,
    projects: projects.map((p) => ({ ...p, status: normalizeProjectStatus(p.status) })),
    invoices: invoices.map((i) => withDisplayStatus(i)),
    payments,
    meetings,
    documents,
    activity,
    portal,
    lead,
    rollup,
  };
}
