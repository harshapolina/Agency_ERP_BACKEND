import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, CREDS, ORG_SLUG, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;
let superAdmin: Api;

beforeAll(async () => {
  t = await startApp();
  [admin, superAdmin] = await Promise.all([t.api.login('admin'), t.api.login('super')]);
});
afterAll(() => t?.close());

describe('auth', () => {
  it('returns the signed-in profile', async () => {
    const me = await admin.ok(admin.get('/auth/me'));
    expect(me.email ?? me.user?.email).toBe(CREDS.admin.email);
  });

  it('only shares branding, never invoice or bank details, with the session', async () => {
    await admin.ok(admin.put('/settings/company', { profile: { bankAccountNumber: '1234567890' } }));
    const login = await t.api.ok(t.api.post('/auth/login', CREDS.admin));
    const me = await admin.ok(admin.get('/auth/me'));
    for (const org of [login.organization, me.organization]) {
      expect(Object.keys(org).sort()).toEqual(['id', 'logo', 'name', 'settings', 'slug']);
    }
    expect(me.organizationId).toBe(me.organization.id);
  });

  it('rejects a wrong password and unauthenticated calls', async () => {
    const bad = await t.api.post('/auth/login', { email: CREDS.admin.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect((await t.api.get('/leads')).status).toBe(401);
  });

  it('keeps company users out of platform admin routes', async () => {
    expect((await admin.get('/admin/organizations')).status).toBe(403);
  });
});

describe('company database (tenancy)', () => {
  let orgId: string;

  beforeAll(async () => {
    const orgs = await superAdmin.ok(superAdmin.get('/admin/organizations'));
    const list = Array.isArray(orgs) ? orgs : orgs.organizations ?? orgs.items;
    orgId = list.find((o: any) => o.slug === ORG_SLUG)._id;
  });

  it('starts on the shared database', async () => {
    const db = await superAdmin.ok(superAdmin.get(`/admin/organizations/${orgId}/database`));
    expect(db).toMatchObject({ enabled: false, status: 'unconfigured' });
  });

  it('rejects malformed URIs without storing anything', async () => {
    const r = await superAdmin.post(`/admin/organizations/${orgId}/database/test`, { uri: 'postgres://nope' });
    expect(r.status).toBe(400);
  });

  it('measures shared-database usage for just this company', async () => {
    const usage = await superAdmin.ok(superAdmin.get(`/admin/organizations/${orgId}/database/usage`));
    expect(usage).toMatchObject({ mode: 'shared', dbName: t.dbName, database: null });
    expect(usage.users).toBeGreaterThanOrEqual(2);
    expect(usage.collections.find((c: any) => c.name === 'leads').documents).toBeGreaterThan(0);
    expect(usage.documents).toBe(usage.collections.reduce((s: number, c: any) => s + c.documents, 0));
    expect(usage.connection).not.toMatch(/:[^*@/]+@/);

    const all = await superAdmin.ok(superAdmin.get('/admin/database-usage'));
    expect(all.find((u: any) => u.organizationId === orgId)).toMatchObject({ mode: 'shared', documents: usage.documents });
    expect((await admin.get(`/admin/organizations/${orgId}/database/usage`)).status).toBe(403);
  });

  it('moves business data to the dedicated database and never echoes the URI', async () => {
    const leadsBefore = await admin.ok(admin.get('/leads'));
    expect(leadsBefore.length).toBeGreaterThan(0);

    const tenantDb = `${t.dbName}_tenant`;
    await superAdmin.ok(superAdmin.post(`/admin/organizations/${orgId}/database/test`, { uri: t.mongoUri, dbName: tenantDb }));
    const saved = await superAdmin.ok(superAdmin.put(`/admin/organizations/${orgId}/database`, { uri: t.mongoUri, dbName: tenantDb }));
    expect(saved).toMatchObject({ enabled: true, status: 'connected', dbName: tenantDb });
    expect(JSON.stringify(saved)).not.toContain('uriCipher');

    expect(await admin.ok(admin.get('/leads'))).toHaveLength(0);
    await admin.ok(admin.post('/lead-categories', { name: 'Tenant Cat' }));
    // Logins still resolve from the platform database.
    await t.api.login('admin');

    const usage = await superAdmin.ok(superAdmin.get(`/admin/organizations/${orgId}/database/usage?fresh=1`));
    expect(usage).toMatchObject({ mode: 'dedicated', dbName: tenantDb, documents: 1 });
    expect(usage.database.collections).toBeGreaterThanOrEqual(1);

    const checked = await superAdmin.ok(superAdmin.post(`/admin/organizations/${orgId}/database/check`));
    expect(checked.status).toBe('connected');

    const detached = await superAdmin.ok(superAdmin.delete(`/admin/organizations/${orgId}/database`));
    expect(detached.enabled).toBe(false);
    expect((await admin.ok(admin.get('/leads'))).length).toBe(leadsBefore.length);
  });
});
