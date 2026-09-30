import { Router } from 'express';
import { z } from 'zod';
import { Conversion, Vendor, PortalAccess, Project, Invoice, Payment, Meeting, OsDocument, ActivityEvent } from '../../../models/index.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, parseBody, oid } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity } from '../../../shared/os/activity.js';
import { ensurePortalActive, rotatePortalToken } from '../services/portal.service.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { withDisplayStatus } from '../../../shared/os/money.js';
import { normalizeProjectStatus } from '../../../shared/constants/os.js';
import { Organization } from '../../../models/Organization.js';
import {
  convertLead, previewDuplicates, conversionHub, createDirectClient, conversionRollup,
} from '../services/conversion.service.js';

// ---------------------------------------------------------------- conversions
export const conversionRoutes = Router();
conversionRoutes.use(authenticate);

conversionRoutes.get(
  '/',
  authorize('conversions:read'),
  route(async (req) => {
    const org = oid(req.user!.organizationId);
    const conversions = await Conversion.find({ organizationId: org, recordStatus: 'active' }).sort({ convertedAt: -1 }).lean();
    const vendors = await Vendor.find({ organizationId: org, conversionUuid: { $in: conversions.map((c) => c.conversionUuid) } })
      .select('conversionUuid companyName')
      .lean();
    const byUuid = new Map(vendors.map((v) => [v.conversionUuid, v]));
    return conversions.map((c) => ({ ...c, vendor: byUuid.get(c.conversionUuid) || null }));
  })
);

conversionRoutes.post(
  '/preview-duplicates',
  authorize('conversions:write'),
  route(async (req) => previewDuplicates(req.user!.organizationId, req.body || {}))
);

const convertSchema = z.object({
  companyName: z.string().optional(),
  contactPerson: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  industry: z.string().optional(),
  gstNumber: z.string().optional(),
  website: z.string().optional(),
  conversionValue: z.coerce.number().optional(),
  services: z.array(z.string()).optional(),
  expectedStart: z.string().optional(),
  owner: z.string().optional(),
  createProject: z.boolean().optional(),
  projectName: z.string().optional(),
  forceNew: z.boolean().optional(),
  selectedVendorId: z.string().optional(),
  notes: z.string().optional(),
});

conversionRoutes.post(
  '/convert-lead/:leadId',
  authorize('conversions:write'),
  route(async (req) => convertLead(actorFrom(req.user!), req.params.leadId as string, parseBody(convertSchema, req.body)))
);

conversionRoutes.get(
  '/code/:publicCode',
  authorize('search:read', 'conversions:read'),
  route(async (req) => {
    const hub = await conversionHub(req.user!.organizationId, req.params.publicCode as string);
    const org = await Organization.findById(req.user!.organizationId).select('slug').lean();
    return { ...hub, organizationSlug: org?.slug };
  })
);

conversionRoutes.post(
  '/:conversionUuid/portal',
  authorize('vendors:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const conversionUuid = req.params.conversionUuid as string;
    const conversion = await Conversion.findOne({ organizationId: actor.organizationId, conversionUuid }).lean();
    if (!conversion) throw new NotFoundError('Conversion');
    const portal = req.body?.rotate ? await rotatePortalToken(actor, conversionUuid) : await ensurePortalActive(actor, conversionUuid);
    await logActivity(actor, { conversionUuid, title: 'Client portal link generated', entityType: 'portal', entityId: conversionUuid });
    return portal;
  })
);

conversionRoutes.delete(
  '/:conversionUuid/portal',
  authorize('vendors:write'),
  route(async (req) => {
    const actor = actorFrom(req.user!);
    const conversionUuid = req.params.conversionUuid as string;
    await PortalAccess.updateOne({ organizationId: actor.organizationId, conversionUuid }, { $set: { isActive: false, updatedBy: actor.email } });
    await logActivity(actor, { conversionUuid, title: 'Client portal revoked', entityType: 'portal', entityId: conversionUuid });
    return { revoked: true };
  })
);

// ---------------------------------------------------------------- clients (vendors)
const vendorSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  contactPerson: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  location: z.string().optional(),
  industry: z.string().optional(),
  gstNumber: z.string().optional(),
  website: z.string().optional(),
  socialLinks: z.string().optional(),
  accountOwner: z.string().optional(),
  notes: z.string().optional(),
  services: z.array(z.string()).optional(),
  conversionValue: z.coerce.number().optional(),
});

export const vendorRoutes = crudRouter({
  model: Vendor,
  resource: 'vendors',
  entityType: 'vendor',
  label: 'Client',
  searchFields: ['companyName', 'contactPerson', 'email', 'phone', 'industry', 'location'],
  filterFields: ['activeStatus', 'industry'],
  defaultSort: { companyName: 1 },
  titleOf: (d) => d.companyName,
  updateSchema: vendorSchema.partial().extend({
    activeStatus: z.enum(['working_on_project', 'active', 'inactive']).optional(),
    relationshipStatus: z.enum(['active', 'inactive', 'churned']).optional(),
  }),
  extend: (router) => {
    router.post(
      '/direct',
      authorize('vendors:write'),
      route(async (req) => createDirectClient(actorFrom(req.user!), parseBody(vendorSchema, req.body)))
    );

    router.get(
      '/:id/overview',
      authorize('vendors:read'),
      route(async (req) => {
        const org = oid(req.user!.organizationId);
        const vendor = await Vendor.findOne({ _id: req.params.id, organizationId: org }).lean();
        if (!vendor) throw new NotFoundError('Client');
        const uuid = vendor.conversionUuid;
        const [conversion, projects, invoices, payments, meetings, documents, activity, rollup, portal] = await Promise.all([
          Conversion.findOne({ organizationId: org, conversionUuid: uuid }).lean(),
          Project.find({ organizationId: org, conversionUuid: uuid, recordStatus: { $ne: 'archived' } }).sort({ createdAt: -1 }).lean(),
          Invoice.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
          Payment.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ paidAt: -1 }).lean(),
          Meeting.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ startsAt: -1 }).limit(10).lean(),
          OsDocument.find({ organizationId: org, conversionUuid: uuid, recordStatus: 'active' }).sort({ createdAt: -1 }).lean(),
          ActivityEvent.find({ organizationId: org, conversionUuid: uuid }).sort({ createdAt: -1 }).limit(30).lean(),
          conversionRollup(req.user!.organizationId, uuid),
          PortalAccess.findOne({ organizationId: org, conversionUuid: uuid }).select('isActive tokenHint lastLoginAt createdAt').lean(),
        ]);
        return {
          vendor, conversion, payments, meetings, documents, activity, rollup, portal,
          projects: projects.map((p) => ({ ...p, status: normalizeProjectStatus(p.status) })),
          invoices: invoices.map((i) => withDisplayStatus(i)),
        };
      })
    );
  },
});
