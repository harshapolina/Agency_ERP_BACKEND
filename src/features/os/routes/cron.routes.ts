import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { Organization } from '../../../models/Organization.js';
import { runWithOrganization } from '../../../config/tenant.js';
import { env } from '../../../config/env.js';
import { route } from '../../../shared/utils/crud.js';
import { UnauthorizedError, ValidationError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';
import { runDailyReminders, runDeadlineReminders, recurringPaymentReminders } from '../services/reminders.service.js';

export const cronRoutes = Router();

function assertCronAuth(header?: string) {
  const secret = env.CRON_SECRET;
  if (!secret) throw new UnauthorizedError('CRON_SECRET is not configured');
  const given = Buffer.from((header || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedError('Invalid cron secret');
}

const SLOTS = ['morning', 'evening', 'deadline', 'recurring'] as const;

cronRoutes.all(
  '/reminders',
  route(async (req) => {
    assertCronAuth(req.headers.authorization);
    const slot = String(req.query.slot || 'deadline') as (typeof SLOTS)[number];
    if (!SLOTS.includes(slot)) throw new ValidationError(`slot must be one of ${SLOTS.join(', ')}`);
    const force = req.query.force === 'true';
    const orgs = await Organization.find({ isActive: true }).select('_id slug').lean();
    const results: Record<string, unknown> = {};
    for (const org of orgs) {
      const id = String(org._id);
      try {
        results[org.slug] = await runWithOrganization(id, async () => {
          if (slot === 'morning' || slot === 'evening') return runDailyReminders(id, slot, force);
          if (slot === 'recurring') return recurringPaymentReminders(id);
          return runDeadlineReminders(id, force);
        });
      } catch (error) {
        logger.error('Cron reminders failed for organization', { org: org.slug, error: (error as Error).message });
        results[org.slug] = { error: (error as Error).message };
      }
    }
    return { slot, organizations: orgs.length, results };
  })
);
