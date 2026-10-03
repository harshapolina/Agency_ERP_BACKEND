import { Router, type Request } from 'express';
import { z } from 'zod';
import { Organization } from '../../../models/Organization.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { route, parseBody, isObjectId } from '../../../shared/utils/crud.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { isMailConfigured, sendNotificationEmail } from '../../../shared/utils/mailer.js';
import { NOTIFICATION_CATEGORIES } from '../../../shared/constants/os.js';
import {
  COMPANY_SELECT, COMPANY_SMTP_SELECT, companyProfileSchema, companyUpdate, notificationEmailsSchema, notificationEmailsUpdate,
  publicCompany, publicNotificationEmails, publicSmtp, smtpSettingsSchema, smtpSettingsUpdate,
} from '../../../shared/os/company.js';
import type { AuthenticatedRequest } from '../../../shared/types/index.js';

const testSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  to: z.string().trim().email().optional(),
});

/**
 * Company profile (logo, invoice details), SMTP, and notification recipients.
 * The same handlers serve company admins (`/settings`) and platform admins (`/admin/organizations/:id/settings`).
 */
function companySettingsRouter(orgIdOf: (req: Request) => string, guard: { read: unknown[]; write: unknown[] }) {
  const router = Router({ mergeParams: true });

  const load = async (req: Request, select = COMPANY_SELECT) => {
    const id = orgIdOf(req);
    if (!isObjectId(id)) throw new NotFoundError('Organization');
    const org = await Organization.findById(id).select(select).lean();
    if (!org) throw new NotFoundError('Organization');
    return org;
  };
  const update = async (req: Request, set: Record<string, unknown>, select = COMPANY_SELECT) => {
    const org = await Organization.findByIdAndUpdate(orgIdOf(req), { $set: set }, { new: true, runValidators: true }).select(select).lean();
    if (!org) throw new NotFoundError('Organization');
    return org;
  };

  router.get('/company', ...(guard.read as never[]), route(async (req) => publicCompany(await load(req))));

  router.put('/company', ...(guard.write as never[]), route(async (req) => {
    const input = parseBody<z.infer<typeof companyProfileSchema>>(companyProfileSchema, req.body);
    return publicCompany(await update(req, companyUpdate(input)));
  }));

  router.get('/smtp', ...(guard.read as never[]), route(async (req) => publicSmtp(await load(req, COMPANY_SMTP_SELECT))));

  router.put('/smtp', ...(guard.write as never[]), route(async (req) => {
    const input = parseBody<z.infer<typeof smtpSettingsSchema>>(smtpSettingsSchema, req.body);
    const current = publicSmtp(await load(req, COMPANY_SMTP_SELECT));
    try {
      const set = smtpSettingsUpdate(input, (req as AuthenticatedRequest).user?.email || 'system', current.passwordConfigured);
      return publicSmtp(await update(req, set, COMPANY_SMTP_SELECT));
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }));

  router.post('/smtp/test', ...(guard.write as never[]), route(async (req) => {
    const { to } = parseBody<z.infer<typeof testSchema>>(testSchema, req.body ?? {});
    const orgId = orgIdOf(req);
    const org = await load(req, COMPANY_SMTP_SELECT);
    const smtp = publicSmtp(org);
    const recipient = (to || smtp.user || (req as AuthenticatedRequest).user?.email || '').trim().toLowerCase();
    if (!recipient) throw new ValidationError('Enter an email address to send the test to');
    if (!(await isMailConfigured(orgId))) {
      throw new ValidationError('Save SMTP settings with an app password first (or configure server SMTP)');
    }
    const ok = await sendNotificationEmail(recipient, {
      eyebrow: org.name || 'Editco OS',
      title: 'SMTP connection works',
      body: `This test was sent using ${smtp.user || 'your company'} SMTP settings for ${org.name}. Task reminders and notification emails will use this mailbox.`,
      href: '/settings',
      ctaLabel: 'Open settings →',
    }, `SMTP test · ${org.name}`, { organizationId: orgId });
    if (!ok) throw new ValidationError('Could not send the test email — check host, port, mailbox, and app password');
    return { sent: 1, to: recipient };
  }));

  router.get('/notification-emails', ...(guard.read as never[]), route(async (req) => publicNotificationEmails(await load(req))));

  router.put('/notification-emails', ...(guard.write as never[]), route(async (req) => {
    const input = parseBody<z.infer<typeof notificationEmailsSchema>>(notificationEmailsSchema, req.body);
    return publicNotificationEmails(await update(req, notificationEmailsUpdate(input)));
  }));

  router.post('/notification-emails/test', ...(guard.write as never[]), route(async (req) => {
    const { category } = parseBody<z.infer<typeof testSchema>>(testSchema, req.body ?? {});
    const orgId = orgIdOf(req);
    const org = await load(req);
    const lists = publicNotificationEmails(org);
    const recipients = [...new Set(category ? lists[category] : Object.values(lists).flat())];
    if (!recipients.length) throw new ValidationError('Add at least one email address first');
    if (!(await isMailConfigured(orgId))) {
      throw new ValidationError('Configure SMTP in Settings (mailbox + app password) before sending test emails');
    }
    const results = await Promise.all(recipients.map((to) => sendNotificationEmail(to, {
      eyebrow: org.name,
      title: 'Test notification',
      body: `This address is set up to receive ${category ? `${category} ` : ''}notifications for ${org.name}.`,
      href: '/settings',
      ctaLabel: 'Open settings →',
    }, `Test notification · ${org.name}`, { organizationId: orgId })));
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
