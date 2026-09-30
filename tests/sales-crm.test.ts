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

  it('only sees its own leads', async () => {
    await employee.ok(employee.post('/sales-crm/leads', { company: 'Mine', contactPerson: 'Me', email: 'm@x.com', phone: '1' }));
    const leads = await employee.ok(employee.get('/sales-crm/leads'));
    const text = JSON.stringify(leads);
    expect(text).toContain('Mine');
    expect(text).not.toContain('CRM Lead');
  });
});
