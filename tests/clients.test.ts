import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;
let lead: any;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
  lead = (await admin.ok(admin.get('/leads')))[0];
});
afterAll(() => t?.close());

describe('lead conversion', () => {
  let conversion: any;

  it('previews duplicates before converting', async () => {
    await admin.ok(admin.post('/conversions/preview-duplicates', { companyName: lead.company, email: lead.email }));
  });

  it('converts a lead into a client with a project', async () => {
    const res = await admin.ok(admin.post(`/conversions/convert-lead/${lead._id}`, {
      companyName: lead.company, conversionValue: 200000, services: ['Website'], createProject: true, projectName: 'Test Project', forceNew: true,
    }));
    conversion = res.conversion ?? res;
    expect(conversion.publicCode).toBeTruthy();
    expect(conversion.conversionUuid).toBeTruthy();

    const list = await admin.ok(admin.get('/conversions'));
    expect(JSON.stringify(list)).toContain(conversion.conversionUuid);
    await admin.ok(admin.get(`/conversions/code/${conversion.publicCode}`));
  });

  it('keeps the client portal token stable across calls', async () => {
    const [a, b] = [
      await admin.ok(admin.post(`/conversions/${conversion.conversionUuid}/portal`)),
      await admin.ok(admin.post(`/conversions/${conversion.conversionUuid}/portal`)),
    ];
    expect(a.token).toBeTruthy();
    expect(b.token).toBe(a.token);
  });

  it('refuses unauthenticated conversions', async () => {
    expect((await t.api.post(`/conversions/convert-lead/${lead._id}`, { companyName: 'x' })).status).toBe(401);
  });
});

describe('direct clients', () => {
  it('creates a client without a lead and returns its overview', async () => {
    const direct = await admin.ok(admin.post('/clients/direct', { companyName: 'Direct Co', email: 'd@x.com', conversionValue: 50000 }));
    const vendorId = direct.vendor?._id ?? direct._id;
    expect(vendorId).toBeTruthy();
    await admin.ok(admin.get(`/clients/${vendorId}/overview`));
    expect(JSON.stringify(await admin.ok(admin.get('/clients')))).toContain('Direct Co');
  });
});
