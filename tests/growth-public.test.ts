import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, ORG_SLUG, startApp, type TestApp } from './helpers.js';

const P = `/public/${ORG_SLUG}`;

let t: TestApp;
let admin: Api;
let visitor: Api;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
  visitor = t.api.anon();
});
afterAll(() => t?.close());

describe('growth', () => {
  it('lists every growth queue', async () => {
    await Promise.all(['/growth/referrers', '/growth/referrals', '/growth/applications', '/growth/ega', '/growth/newsletter'].map((p) => admin.ok(admin.get(p))));
  });
});

describe('public pages', () => {
  it('serves the client portal and project tracker without a login', async () => {
    const lead = (await admin.ok(admin.get('/leads')))[0];
    const res = await admin.ok(admin.post(`/conversions/convert-lead/${lead._id}`, { companyName: lead.company, conversionValue: 1000, forceNew: true }));
    const conversion = res.conversion ?? res;
    const portal = await admin.ok(admin.post(`/conversions/${conversion.conversionUuid}/portal`));

    await visitor.ok(visitor.get(`${P}/portal/${portal.token}`));
    await visitor.ok(visitor.get(`${P}/track/${conversion.publicCode}`));
    expect((await visitor.get(`${P}/portal/not-a-real-token`)).status).toBeGreaterThanOrEqual(400);
  });

  it('publishes jobs and accepts applications', async () => {
    const job = await admin.ok(admin.post('/growth/jobs', { title: 'Video Editor', status: 'published', description: 'Edit', location: 'Remote' }));
    const careers = await visitor.ok(visitor.get(`${P}/careers`));
    expect(JSON.stringify(careers)).toContain('Video Editor');
    await visitor.ok(visitor.post(`${P}/careers/${job.slug}/apply`, { applicantName: 'App', applicantEmail: 'a@x.com', applicantPhone: '1' }));
    const apps = await admin.ok(admin.get(`/growth/applications?jobId=${job._id}`));
    expect(JSON.stringify(apps)).toContain('a@x.com');
  });

  it('lets referrers check status and submit referrals', async () => {
    const ref = await admin.ok(admin.post('/growth/referrers', { fullName: 'Ref One', email: 'ref@x.com', phone: '1' }));
    await visitor.ok(visitor.get(`${P}/referrers/${ref.referralCode}?email=ref@x.com`));
    await visitor.ok(visitor.post(`${P}/referrals`, {
      referralCode: ref.referralCode, referredName: 'Friend', referredBusiness: 'FriendCo', referredEmail: 'f@x.com', referredPhone: '2',
    }));
    expect(JSON.stringify(await admin.ok(admin.get('/growth/referrals')))).toContain('FriendCo');
  });

  it('accepts EGA applications and newsletter sign-ups', async () => {
    await visitor.ok(visitor.post(`${P}/ega`, { fullName: 'E', email: 'e@x.com', company: 'EC', monthlyBudget: 50000 }));
    await visitor.ok(visitor.post(`${P}/newsletter`, { email: 'n@x.com' }));
    const news = await admin.ok(admin.get('/growth/newsletter'));
    expect(JSON.stringify(news)).toContain('n@x.com');
  });

  it('returns 404 for unknown companies', async () => {
    expect((await visitor.get('/public/no-such-company/careers')).status).toBe(404);
  });
});
