import { Router } from 'express';
import { z } from 'zod';
import { SalesActivityEvent, SalesCall, SalesFollowUp, SalesLead, SalesPhoneLink } from '../../../models/index.js';
import { SALES_CALL_FORM_OUTCOMES } from '../../../shared/constants/os.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import type { AuthenticatedRequest } from '../../../shared/types/index.js';
import { isObjectId, parseBody, route } from '../../../shared/utils/crud.js';
import { getCallProvider } from './provider.js';

const PENDING_MS = 10 * 60_000;

interface SalesBag {
  employeeId: string;
  isSalesAdmin: boolean;
  name: string;
}

function salesOf(req: AuthenticatedRequest): SalesBag {
  const sales = (req as AuthenticatedRequest & { sales?: SalesBag }).sales;
  if (!sales) throw new ValidationError('Sales CRM session missing');
  return sales;
}

function present(call: {
  _id: unknown;
  leadId?: unknown;
  employeeId?: unknown;
  phone?: string;
  status?: string;
  channel?: string;
  provider?: string;
  calledAt?: Date;
  dialedAt?: Date;
  endedAt?: Date;
  durationSeconds?: number | null;
  durationSource?: string;
  outcome?: string;
  notes?: string;
  nextFollowUpAt?: Date;
}) {
  return {
    _id: call._id,
    leadId: call.leadId,
    employeeId: call.employeeId,
    phone: call.phone || '',
    telUri: call.phone ? `tel:${call.phone}` : '',
    status: call.status || 'completed',
    channel: call.channel || 'manual',
    provider: call.provider || 'device_sim',
    calledAt: call.calledAt,
    dialedAt: call.dialedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds ?? null,
    durationSource: call.durationSource || 'unavailable',
    outcome: call.outcome || '',
    notes: call.notes || '',
    nextFollowUpAt: call.nextFollowUpAt || null,
    reportsCarrierEvents: false,
  };
}

async function ownCall(req: AuthenticatedRequest, id: string) {
  if (!isObjectId(id)) throw new NotFoundError('Call');
  const sales = salesOf(req);
  const call = await SalesCall.findOne({
    _id: id,
    organizationId: req.user!.organizationId,
    employeeId: sales.employeeId,
    recordStatus: 'active',
  });
  if (!call) throw new NotFoundError('Call');
  return call;
}

async function ownLead(req: AuthenticatedRequest, leadId: string) {
  if (!isObjectId(leadId)) throw new NotFoundError('Lead');
  const sales = salesOf(req);
  const lead = await SalesLead.findOne({
    _id: leadId,
    organizationId: req.user!.organizationId,
    recordStatus: 'active',
    ...(sales.isSalesAdmin ? {} : { assignedEmployeeId: sales.employeeId }),
  });
  if (!lead) throw new NotFoundError('Lead');
  return lead;
}

function followUpDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00.000Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Next follow-up date is not valid');
  return date;
}

export const callingRoutes = Router();

callingRoutes.post('/phone/heartbeat', route(async (req) => {
  const sales = salesOf(req);
  const body = parseBody<{ deviceId: string }>(z.object({ deviceId: z.string().min(8).max(80) }), req.body);
  const organizationId = req.user!.organizationId;
  const now = new Date();
  await SalesPhoneLink.findOneAndUpdate(
    { organizationId, employeeId: sales.employeeId, deviceId: body.deviceId },
    {
      $set: {
        userId: req.user!.id,
        lastSeenAt: now,
        userAgent: String(req.get('user-agent') || '').slice(0, 180),
        updatedBy: req.user!.email,
        recordStatus: 'active',
      },
      $setOnInsert: { organizationId, employeeId: sales.employeeId, deviceId: body.deviceId, createdBy: req.user!.email },
    },
    { upsert: true }
  );

  const pending = await SalesCall.findOne({
    organizationId,
    employeeId: sales.employeeId,
    channel: 'linked_phone',
    status: { $in: ['initiated', 'dialing'] },
    recordStatus: 'active',
    calledAt: { $gte: new Date(Date.now() - PENDING_MS) },
  }).sort({ calledAt: 1 }).populate('leadId', 'contactPerson');

  const lead = pending?.leadId as { contactPerson?: string } | null;
  return {
    linked: true,
    pending: pending ? {
      id: pending._id,
      telUri: pending.phone ? `tel:${pending.phone}` : '',
      leadName: lead?.contactPerson || 'Lead',
      status: pending.status,
    } : null,
  };
}));

callingRoutes.post('/sessions', route(async (req, res) => {
  const sales = salesOf(req);
  const body = parseBody<{ leadId: string; handset?: boolean }>(
    z.object({ leadId: z.string().min(1), handset: z.boolean().optional() }),
    req.body
  );
  const lead = await ownLead(req, body.leadId);
  const plan = getCallProvider('device_sim').prepare(String(lead.phone || ''));
  const organizationId = req.user!.organizationId;
  const channel = body.handset ? 'this_device' : 'os_phone_link';

  await SalesCall.updateMany(
    { organizationId, employeeId: sales.employeeId, status: { $in: ['initiated', 'dialing'] }, recordStatus: 'active' },
    { $set: { status: 'cancelled', updatedBy: req.user!.email } }
  );

  const call = await SalesCall.create({
    organizationId,
    leadId: lead._id,
    employeeId: sales.employeeId,
    phone: plan.phone,
    status: 'initiated',
    channel,
    provider: plan.provider,
    calledAt: new Date(),
    durationSource: 'unavailable',
    outcome: '',
    createdBy: req.user!.email,
    updatedBy: req.user!.email,
  });

  await SalesActivityEvent.create({
    organizationId,
    type: 'call_started',
    title: `Call started with ${lead.contactPerson}`,
    actorEmployeeId: sales.employeeId,
    actorName: sales.name,
    leadId: lead._id,
    metadata: { callId: String(call._id), channel, provider: plan.provider },
    createdBy: req.user!.email,
  });

  res.status(201);
  return {
    ...present(call),
    telUri: plan.telUri,
    leadName: lead.contactPerson,
    handset: Boolean(body.handset),
  };
}));

callingRoutes.get('/sessions/open', route(async (req) => {
  const sales = salesOf(req);
  const leadId = String(req.query.leadId || '');
  if (!isObjectId(leadId)) return null;
  await ownLead(req, leadId);
  const call = await SalesCall.findOne({
    organizationId: req.user!.organizationId,
    employeeId: sales.employeeId,
    leadId,
    status: { $in: ['initiated', 'dialing', 'awaiting_outcome'] },
    recordStatus: 'active',
    calledAt: { $gte: new Date(Date.now() - 2 * 60 * 60_000) },
  }).sort({ calledAt: -1 });
  return call ? present(call) : null;
}));

callingRoutes.get('/sessions/:id', route(async (req) => present(await ownCall(req, String(req.params.id)))));

callingRoutes.post('/sessions/:id/dialing', route(async (req) => {
  const call = await ownCall(req, String(req.params.id));
  if (!['initiated', 'dialing'].includes(String(call.status))) throw new ValidationError('This call is no longer in progress');
  const body = parseBody<{ channel?: 'this_device' | 'linked_phone' | 'os_phone_link' }>(
    z.object({ channel: z.enum(['this_device', 'linked_phone', 'os_phone_link']).optional() }),
    req.body
  );
  if (call.status === 'initiated') {
    call.status = 'dialing';
    call.dialedAt = new Date();
  }
  if (body.channel) call.channel = body.channel;
  call.updatedBy = req.user!.email;
  await call.save();
  return present(call);
}));

callingRoutes.post('/sessions/:id/handoff', route(async (req) => {
  const call = await ownCall(req, String(req.params.id));
  if (!['initiated', 'dialing'].includes(String(call.status))) throw new ValidationError('This call is no longer in progress');
  call.channel = 'linked_phone';
  call.updatedBy = req.user!.email;
  await call.save();
  return present(call);
}));

callingRoutes.post('/sessions/:id/end', route(async (req) => {
  const call = await ownCall(req, String(req.params.id));
  if (call.status === 'completed' || call.status === 'cancelled') throw new ValidationError('This call is already finished');
  const body = parseBody<{ durationSource?: 'phone_return' | 'crm_timer'; durationSeconds?: number }>(
    z.object({
      durationSource: z.enum(['phone_return', 'crm_timer']).optional(),
      durationSeconds: z.coerce.number().min(0).max(4 * 3600).optional(),
    }),
    req.body
  );
  const source = body.durationSource || 'crm_timer';
  if (call.durationSource === 'phone_return' && source !== 'phone_return') {
    call.status = 'awaiting_outcome';
    call.updatedBy = req.user!.email;
    await call.save();
    return present(call);
  }

  const now = new Date();
  const start = call.dialedAt || call.calledAt;
  let seconds: number | null = null;
  if (source === 'phone_return' && start) seconds = Math.max(0, Math.round((now.getTime() - new Date(start).getTime()) / 1000));
  else if (typeof body.durationSeconds === 'number') seconds = Math.round(body.durationSeconds);

  call.endedAt = now;
  call.durationSeconds = seconds;
  call.durationSource = seconds == null ? 'unavailable' : source;
  call.durationMinutes = seconds == null ? 0 : Math.round(seconds / 60);
  call.status = 'awaiting_outcome';
  call.updatedBy = req.user!.email;
  await call.save();
  return present(call);
}));

callingRoutes.post('/sessions/:id/cancel', route(async (req) => {
  const call = await ownCall(req, String(req.params.id));
  if (call.status === 'completed') throw new ValidationError('This call is already saved');
  call.status = 'cancelled';
  call.updatedBy = req.user!.email;
  await call.save();
  return present(call);
}));

callingRoutes.post('/sessions/:id/outcome', route(async (req, res) => {
  const sales = salesOf(req);
  const call = await ownCall(req, String(req.params.id));
  if (call.status === 'cancelled') throw new ValidationError('This call was cancelled');
  if (call.status === 'completed') throw new ValidationError('This call outcome is already saved');
  const body = parseBody<{ outcome: string; notes?: string; nextFollowUpAt?: string }>(
    z.object({
      outcome: z.enum(SALES_CALL_FORM_OUTCOMES),
      notes: z.string().max(4000).optional(),
      nextFollowUpAt: z.string().optional(),
    }),
    req.body
  );

  const now = new Date();
  if (!call.endedAt) call.endedAt = now;
  if (!call.dialedAt) call.dialedAt = call.calledAt;
  call.outcome = body.outcome;
  call.notes = body.notes?.trim() || '';
  call.status = 'completed';
  call.updatedBy = req.user!.email;

  let followUpAt: Date | undefined;
  if (body.nextFollowUpAt) {
    followUpAt = followUpDate(body.nextFollowUpAt);
    call.nextFollowUpAt = followUpAt;
  }
  await call.save();

  const organizationId = req.user!.organizationId;
  if (call.leadId) {
    const patch: Record<string, unknown> = { lastContactedAt: now, updatedBy: req.user!.email };
    if (followUpAt) patch.nextFollowUpAt = followUpAt;
    await SalesLead.updateOne({ _id: call.leadId, organizationId }, { $set: patch });
  }
  if (followUpAt) {
    await SalesFollowUp.create({
      organizationId,
      leadId: call.leadId || undefined,
      ownerEmployeeId: sales.employeeId,
      type: 'call',
      dueAt: followUpAt,
      notes: call.notes || 'Follow-up from call',
      createdBy: req.user!.email,
    });
  }

  await SalesActivityEvent.create({
    organizationId,
    type: 'call_logged',
    title: `Call logged (${body.outcome.replace(/_/g, ' ')})`,
    actorEmployeeId: sales.employeeId,
    actorName: sales.name,
    leadId: call.leadId,
    metadata: { callId: String(call._id), outcome: body.outcome },
    createdBy: req.user!.email,
  });

  res.status(201);
  return present(call);
}));
