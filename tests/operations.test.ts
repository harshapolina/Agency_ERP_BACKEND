import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
});
afterAll(() => t?.close());

describe('overview', () => {
  it.each([
    '/os/dashboard', '/os/search?q=Tech', '/os/activity', '/os/analytics',
    '/services', '/industries', '/tracker', '/vault', '/dashboard/stats',
  ])('GET %s', async (path) => {
    await admin.ok(admin.get(path));
  });
});

describe('cron', () => {
  const path = '/cron/reminders?slot=recurring';

  it('requires the cron secret', async () => {
    expect((await t.api.get(path)).status).toBe(401);
    expect((await t.api.as('wrong-secret').get(path)).status).toBe(401);
  });

  it('runs with the cron secret', async () => {
    await t.api.ok(t.api.as(process.env.CRON_SECRET!).get(path));
  });
});
