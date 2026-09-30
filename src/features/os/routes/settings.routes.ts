import { Router, type Request } from 'express';
import { z } from 'zod';
import { Organization } from '../../../models/Organization.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { route, parseBody, isObjectId } from '../../../shared/utils/crud.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { isMailConfigured, sendNotificationEmail } from '../../../shared/utils/mailer.js';
import { NOTIFICATION_CATEGORIES } from '../../../shared/constants/os.js';
import {
  COMPANY_SELECT, companyProfileSchema, companyUpdate, notificationEmailsSchema, notificationEmailsUpdate,
  publicCompany, publicNotificationEmails,
} from '../../../shared/os/company.js';
import type { AuthenticatedRequest } from '../../../shared/types/index.js';

const testSchema = z.object({ category: z.enum(NOTIFICATION_CATEGORIES).optional() });

/**
 * Company profile (logo, invoice details) and notification recipients.
 * The same handlers serve company admins (`/settings`) and platform admins (`/admin/organizations/:id/settings`).
 */
function companySettingsRouter(orgIdOf: (req: Request) => string, guard: { read: unknown[]; write: unknown[] }) {
  const router = Router({ mergeParams: true });

  const load = async (req: Request) => {
    const id = orgIdOf(req);
    if (!isObjectId(id)) throw new NotFoundError('Organization');
    const org = await Organization.findById(id).select(COMPANY_SELECT).lean();
    if (!org) throw new NotFoundError('Organization');
    return org;
  };
  const update = async (req: Request, set: Record<string, unknown>) => {
    const org = await Organization.findByIdAndUpdate(orgIdOf(req), { $set: set }, { new: true, runValidators: true }).select(COMPANY_SELECT).lean();
    if (!org) throw new NotFoundError('Organization');
    return org;
  };

  router.get('/company', ...(guard.read as never[]), route(async (req) => publicCompany(await load(req))));

  router.put('/company', ...(guard.write as never[]), route(async (req) => {
    const input = parseBody<z.infer<typeof companyProfileSchema>>(companyProfileSchema, req.body);
    return publicCompany(await update(req, companyUpdate(input)));
  }));

  router.get('/notification-emails', ...(guard.read as never[]), route(async (req) => publicNotificationEmails(await load(req))));

  router.put('/notification-emails', ...(guard.write as never[]), route(async (req) => {
    const input = parseBody<z.infer<typeof notificationEmailsSchema>>(notificationEmailsSchema, req.body);
    return publicNotificationEmails(await update(req, notificationEmailsUpdate(input)));
  }));

  router.post('/notification-emails/test', ...(guard.write as never[]), route(async (req) => {
    const { category } = parseBody<z.infer<typeof testSchema>>(testSchema, req.body ?? {});
    const org = await load(req);
    const lists = publicNotificationEmails(org);
    const recipients = [...new Set(category ? lists[category] : Object.values(lists).flat())];
    if (!recipients.length) throw new ValidationError('Add at least one email address first');
    if (!isMailConfigured()) throw new ValidationError('Email sending is not configured on the server (SMTP)');
    const results = await Promise.all(recipients.map((to) => sendNotificationEmail(to, {
      eyebrow: org.name,
      title: 'Test notification',
      body: `This address is set up to receive ${category ? `${category} ` : ''}notifications for ${org.name}.`,
      href: '/settings',
      ctaLabel: 'Open settings →',
    }, `Test notification · ${org.name}`)));
    const failed = recipients.filter((_, i) => !results[i]);
    if (failed.length === recipients.length) throw new ValidationError('Could not send the test email — check the SMTP settings');
    return { sent: recipients.length - failed.length, failed };
  }));

  return router;
}

export const settingsRoutes = Router();
settingsRoutes.use(authenticate);
settingsRoutes.use(companySettingsRouter((req) => (req as AuthenticatedRequest).user!.organizationId, {
  read: [authorize('settings:read')],
  write: [authorize('settings:write')],
}));

/** Mounted under `/admin/organizations/:id/settings` (super admin only). */
export const organizationSettingsRoutes = companySettingsRouter((req) => String(req.params.id), { read: [], write: [] });
