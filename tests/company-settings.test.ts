import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, ORG_SLUG, startApp, type TestApp } from './helpers.js';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));

vi.mock('../src/shared/utils/mailer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/utils/mailer.js')>();
  return {
    ...original,
    isMailConfigured: () => true,
    sendMail: async (to: string | string[], subject: string) => {
      for (const t of [to].flat()) mail.sent.push({ to: t, subject });
      return true;
    },
    sendNotificationEmail: async (to: string | string[], email: { title: string }, subject = email.title) => {
      for (const t of [to].flat()) mail.sent.push({ to: t, subject });
      return true;
    },
  };
});

const LOGO = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;
const PROFILE = { legalName: 'Editco Media Pvt Ltd', gst: '29ABCDE1234F1Z5', bankUpi: 'editco@upi', address: '1 MG Road, Bengaluru' };

let t: TestApp;
let admin: Api;
let sales: Api;
let superAdmin: Api;

beforeAll(async () => {
  t = await startApp();
  [admin, sales, superAdmin] = await Promise.all([t.api.login('admin'), t.api.login('sales'), t.api.login('super')]);
});
afterAll(() => t?.close());
beforeEach(() => {
  mail.sent.length = 0;
});

describe('company profile', () => {
  it('starts empty and prints the company name on invoices', async () => {
    const company = await admin.ok(admin.get('/settings/company'));
    expect(company).toMatchObject({ slug: ORG_SLUG, logo: '', profile: { gst: '', bankUpi: '' } });
    const seller = await admin.ok(admin.get('/invoices/company'));
    expect(seller.fromName).toBe(company.name);
  });

  it('saves the logo and invoice details and uses them on invoices', async () => {
    const saved = await admin.ok(admin.put('/settings/company', { logo: LOGO, profile: PROFILE }));
    expect(saved).toMatchObject({ logo: LOGO, profile: PROFILE });

    await admin.ok(admin.put('/settings/company', { profile: { phone: '+91 90000 00000' } }));
    const seller = await admin.ok(admin.get('/invoices/company'));
    expect(seller).toMatchObject({ fromName: PROFILE.legalName, fromGst: PROFILE.gst, bankUpi: PROFILE.bankUpi, fromPhone: '+91 90000 00000', logoUrl: LOGO });
  });

  it('rejects unsafe or oversized logos', async () => {
    for (const logo of ['data:image/svg+xml;base64,PHN2Zz4=', 'http://insecure.example/logo.png', `data:image/png;base64,${'A'.repeat(310_000)}`]) {
      expect((await admin.put('/settings/company', { logo })).status).toBe(400);
    }
  });

  it('lets only settings admins change it', async () => {
    expect((await sales.put('/settings/company', { profile: { gst: 'x' } })).status).toBe(403);
    expect((await t.api.get('/settings/company')).status).toBe(401);
  });
});

describe('notification emails', () => {
  it('normalises and de-duplicates addresses and rejects invalid ones', async () => {
    const saved = await admin.ok(admin.put('/settings/notification-emails', { finance: ['Accounts@Client.com', 'accounts@client.com'], careers: ['hr@client.com'] }));
    expect(saved).toMatchObject({ finance: ['accounts@client.com'], careers: ['hr@client.com'], sales: [], alerts: [] });
    expect((await admin.put('/settings/notification-emails', { finance: ['not-an-email'] })).status).toBe(400);
    expect((await admin.ok(admin.get('/settings/notification-emails'))).finance).toEqual(['accounts@client.com']);
  });

  it('sends a test email to the configured addresses', async () => {
    const r = await admin.ok(admin.post('/settings/notification-emails/test', { category: 'careers' }));
    expect(r.sent).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual(['hr@client.com']);
  });

  it('emails the configured addresses when the event happens', async () => {
    const job = await admin.ok(admin.post('/growth/jobs', { title: 'Motion Designer', status: 'published', description: 'x' }));
    await t.api.ok(t.api.post(`/public/${ORG_SLUG}/careers/${job.slug}/apply`, { applicantName: 'A', applicantEmail: 'a@x.com', applicantPhone: '1' }));
    expect(mail.sent.some((m) => m.to === 'hr@client.com' && m.subject.includes('Motion Designer'))).toBe(true);
    expect(mail.sent.some((m) => m.to === 'accounts@client.com')).toBe(false);
  });
});

describe('platform admin', () => {
  it('creates a company with a logo and keeps its invoice details separate', async () => {
    const created = await superAdmin.ok(superAdmin.post('/admin/organizations', {
      name: 'Second Agency', logo: LOGO, adminEmail: 'owner@second.test', adminPassword: 'Second#Test1234', adminFirstName: 'Sam', adminLastName: 'Lee',
    }));
    const orgId = created.organization?._id ?? created._id;

    const other = await superAdmin.ok(superAdmin.get(`/admin/organizations/${orgId}/settings/company`));
    expect(other).toMatchObject({ name: 'Second Agency', logo: LOGO, profile: { gst: '' } });

    await superAdmin.ok(superAdmin.put(`/admin/organizations/${orgId}/settings/company`, { profile: { gst: '07SECOND0000Z1' } }));
    await superAdmin.ok(superAdmin.put(`/admin/organizations/${orgId}/settings/notification-emails`, { finance: ['billing@second.test'] }));

    const { accessToken } = await t.api.ok(t.api.post('/auth/login', { email: 'owner@second.test', password: 'Second#Test1234' }));
    const seller = await t.api.as(accessToken).ok(t.api.as(accessToken).get('/invoices/company'));
    expect(seller).toMatchObject({ fromName: 'Second Agency', fromGst: '07SECOND0000Z1', bankUpi: '' });

    expect((await admin.ok(admin.get('/settings/notification-emails'))).finance).toEqual(['accounts@client.com']);
  });

  it('is not reachable by company admins', async () => {
    const orgs = await superAdmin.ok(superAdmin.get('/admin/organizations'));
    const id = (Array.isArray(orgs) ? orgs : orgs.organizations)[0]._id;
    expect((await admin.get(`/admin/organizations/${id}/settings/company`)).status).toBe(403);
  });
});
