import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startApp, type TestApp } from './helpers.js';

const EMPLOYEE = { name: 'Emp One', email: 'emp1@test.local', password: 'Emp#Test1234' };

let t: TestApp;
let admin: Api;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
});
afterAll(() => t?.close());

describe('sales admin', () => {
  it('provisions the company admin as a sales admin', async () => {
    const me = await admin.ok(admin.get('/sales-crm/me'));
    expect(me.isSalesAdmin).toBe(true);
    await admin.ok(admin.get('/sales-crm/dashboard'));
  });

  it('runs a lead through a won deal', async () => {
    const lead = await admin.ok(admin.post('/sales-crm/leads', { company: 'CRM Lead', contactPerson: 'Bob', email: 'b@x.com', phone: '9' }));
    const deal = await admin.ok(admin.post('/sales-crm/deals', { leadId: lead._id, dealName: 'CRM Deal', value: 90000 }));
    const closed = await admin.ok(admin.post(`/sales-crm/deals/${deal._id}/close`, { outcome: 'won', finalOffer: 85000 }));
    expect(closed).toMatchObject({ stage: 'won', finalOffer: 85000 });
    await Promise.all(['/sales-crm/leads', '/sales-crm/customers', '/sales-crm/performance', '/sales-crm/leaderboard', '/sales-crm/analytics'].map((p) => admin.ok(admin.get(p))));
  });

  it('allows one check-in per day', async () => {
    await admin.ok(admin.post('/sales-crm/attendance/check-in'));
    expect((await admin.post('/sales-crm/attendance/check-in')).status).toBe(400);
  });
});

describe('sales employee', () => {
  let employee: Api;

  beforeAll(async () => {
    await admin.ok(admin.post('/sales-crm/employees', EMPLOYEE));
    const { accessToken } = await admin.ok(t.api.post('/auth/login', { email: EMPLOYEE.email, password: EMPLOYEE.password }));
    employee = t.api.as(accessToken);
  });

  it('rejects duplicate employees', async () => {
    expect((await admin.post('/sales-crm/employees', EMPLOYEE)).status).toBe(409);
  });

  it('is kept out of admin-only endpoints', async () => {
    const me = await employee.ok(employee.get('/sales-crm/me'));
    expect(me.isSalesAdmin).toBe(false);
    expect((await employee.get('/sales-crm/analytics')).status).toBe(403);
    expect((await employee.post('/sales-crm/employees', { name: 'X', email: 'x@test.local', password: 'Xx#Test1234' })).status).toBe(403);
  });

  it('places a SIM call on the employee phone and stores the outcome', async () => {
    expect((await t.api.anon().post('/sales-crm/calling/sessions', { leadId: 'x' })).status).toBe(401);

    const foreign = await admin.ok(admin.post('/sales-crm/leads', { contactPerson: 'Not Mine', phone: '9876543210' }));
    expect((await employee.post('/sales-crm/calling/sessions', { leadId: foreign._id, handset: true })).status).toBe(404);

    const bad = await employee.ok(employee.post('/sales-crm/leads', { contactPerson: 'Short', phone: '12' }));
    expect((await employee.post('/sales-crm/calling/sessions', { leadId: bad._id, handset: true })).status).toBe(400);

    const lead = await employee.ok(employee.post('/sales-crm/leads', { company: 'Acme', contactPerson: 'Rahul', phone: '9876543210' }));
    const started = await employee.ok(employee.post('/sales-crm/calling/sessions', { leadId: lead._id, handset: false }));
    expect(started).toMatchObject({
      channel: 'os_phone_link',
      provider: 'device_sim',
      telUri: 'tel:+919876543210',
      phone: '+919876543210',
      reportsCarrierEvents: false,
      status: 'initiated',
    });
    expect(started.recordingUrl).toBeUndefined();

    await employee.ok(employee.post(`/sales-crm/calling/sessions/${started._id}/dialing`, { channel: 'os_phone_link' }));
    const ended = await employee.ok(employee.post(`/sales-crm/calling/sessions/${started._id}/end`, { durationSource: 'phone_return' }));
    expect(ended.status).toBe('awaiting_outcome');
    expect(ended.durationSource).toBe('phone_return');
    expect(typeof ended.durationSeconds).toBe('number');

    const saved = await employee.ok(employee.post(`/sales-crm/calling/sessions/${started._id}/outcome`, {
      outcome: 'interested',
      notes: 'Asked for pricing',
      nextFollowUpAt: '2026-10-04',
    }));
    expect(saved).toMatchObject({ status: 'completed', outcome: 'interested', notes: 'Asked for pricing' });

    const detail = await employee.ok(employee.get(`/sales-crm/leads/${lead._id}`));
    expect(detail.calls[0]).toMatchObject({ outcome: 'interested', notes: 'Asked for pricing', phone: '+919876543210' });
    expect(detail.calls[0].callerName).toContain('Emp');
    expect(detail.followUps.some((row: { notes?: string }) => row.notes === 'Asked for pricing')).toBe(true);

    const dash = await employee.ok(employee.get('/sales-crm/dashboard'));
    expect(dash.callAnalytics.totalCalls).toBeGreaterThanOrEqual(1);
    expect(dash.callAnalytics.connectedCalls).toBeGreaterThanOrEqual(1);
    expect(dash.callAnalytics.interestedLeads).toBeGreaterThanOrEqual(1);
    expect(dash.callAnalytics.followUpsCreated).toBeGreaterThanOrEqual(1);
    expect(dash.callAnalytics.byEmployee).toEqual([]);

    const adminDash = await admin.ok(admin.get('/sales-crm/dashboard'));
    expect(adminDash.callAnalytics.byEmployee.some((row: { calls: number }) => row.calls >= 1)).toBe(true);

    expect((await admin.post(`/sales-crm/calling/sessions/${started._id}/outcome`, { outcome: 'busy' })).status).toBe(404);
  });

  it('only sees its own leads', async () => {
    await employee.ok(employee.post('/sales-crm/leads', { company: 'Mine', contactPerson: 'Me', email: 'm@x.com', phone: '1' }));
    const leads = await employee.ok(employee.get('/sales-crm/leads'));
    const text = JSON.stringify(leads);
    expect(text).toContain('Mine');
    expect(text).not.toContain('CRM Lead');
  });
});
