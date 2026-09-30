import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;
let sales: Api;
let lead: any;

const analytics = (q = '') => admin.ok(admin.get(`/leads/pipeline/analytics${q}`));
const column = (a: any, key: string) => a.columns.find((c: any) => c.key === key);
const stage = (a: any, key: string) => a.stages.find((s: any) => s.key === key).reached;

beforeAll(async () => {
  t = await startApp();
  [admin, sales] = await Promise.all([t.api.login('admin'), t.api.login('sales')]);
  const categories = await admin.ok(admin.get('/lead-categories'));
  lead = await admin.ok(admin.post('/leads', {
    firstName: 'Funnel', lastName: 'Test', company: 'Funnel Co', categoryId: categories[0]._id, estimatedValue: 50000, source: 'referral',
  }));
});
afterAll(() => t?.close());

describe('pipeline analytics', () => {
  it('summarises every active lead into funnel stages and board columns', async () => {
    const a = await analytics();
    expect(a.total).toBeGreaterThan(0);
    expect(stage(a, 'new')).toBe(a.total);
    expect(a.columns.map((c: any) => c.key)).toEqual(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'lost', 'on_hold']);
    expect(column(a, 'new').leads.some((l: any) => l._id === lead._id)).toBe(true);
    expect(a.openValue).toBeGreaterThanOrEqual(50000);
    expect(a.sources).toContain('referral');
  });

  it('filters by source and period', async () => {
    const a = await analytics('?source=referral&range=30d');
    expect(a.total).toBeGreaterThanOrEqual(1);
    expect(a.columns.flatMap((c: any) => c.leads).every((l: any) => l.source === 'referral')).toBe(true);
    expect((await analytics('?range=bogus')).total).toBe((await analytics()).total);
  });
});

describe('moving leads on the board', () => {
  it('requires a reason and write access', async () => {
    expect((await admin.post(`/leads/${lead._id}/move`, { status: 'proposal' })).status).toBe(400);
    expect((await admin.post(`/leads/${lead._id}/move`, { status: 'converted', reason: 'x' })).status).toBe(400);
    expect((await t.api.post(`/leads/${lead._id}/move`, { status: 'proposal', reason: 'x' })).status).toBe(401);
  });

  it('keeps credit for the furthest stage after a lead is lost', async () => {
    const before = await analytics();
    await admin.ok(admin.post(`/leads/${lead._id}/move`, { status: 'proposal', reason: 'Proposal sent' }));
    await admin.ok(admin.post(`/leads/${lead._id}/move`, { status: 'lost', reason: 'Chose a competitor' }));

    const after = await analytics();
    expect(stage(after, 'proposal')).toBe(stage(before, 'proposal') + 1);
    expect(after.lost).toBe(before.lost + 1);
    expect(after.openValue).toBe(before.openValue - 50000);
    expect(column(after, 'lost').total).toBe(column(before, 'lost').total + 50000);

    const activities = await admin.ok(admin.get(`/leads/${lead._id}/activities`));
    expect(activities.find((a: any) => a.description === 'Chose a competitor')).toMatchObject({ type: 'status_change', metadata: { from: 'proposal', to: 'lost' } });
  });

  it('lets users with lead access read the pipeline', async () => {
    await sales.ok(sales.get('/leads/pipeline/analytics'));
  });
});
