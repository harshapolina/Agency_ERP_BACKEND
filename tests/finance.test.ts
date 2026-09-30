import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, days, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;
let pid: string;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
  pid = (await admin.ok(admin.post('/projects', { name: 'Billing', status: 'planned' })))._id;
});
afterAll(() => t?.close());

describe('invoices', () => {
  let inv: any;

  it('numbers and totals a zero-tax invoice', async () => {
    inv = await admin.ok(admin.post('/invoices', {
      projectId: pid, taxRate: 0, status: 'issued', dueDate: days(7),
      lineItems: [{ description: 'Work', quantity: 2, unitPrice: 10000 }],
    }));
    expect(inv.total).toBe(20000);
    expect(inv.invoiceNumber).toMatch(/^EC-INV-\d{4}-\d{3,}$/);
    await admin.ok(admin.get(`/invoices/${inv._id}`));
  });

  it('applies discount before inter-state GST', async () => {
    const igst = await admin.ok(admin.post('/invoices', {
      projectId: pid, taxRate: 0.18, isInterState: true, overallDiscount: 1000,
      lineItems: [{ description: 'X', quantity: 1, unitPrice: 50000 }],
    }));
    expect(igst.igstAmount).toBe(8820);
    expect(igst.total).toBe(57820);
  });

  it('requires a reason to edit an invoice that has payments', async () => {
    await admin.ok(admin.post('/payments', { invoiceId: inv._id, amount: 5000, method: 'upi', paidAt: new Date().toISOString() }));
    const lineItems = [{ description: 'Work', quantity: 3, unitPrice: 10000 }];
    expect((await admin.patch(`/invoices/${inv._id}`, { lineItems })).status).toBe(400);
    const edited = await admin.ok(admin.patch(`/invoices/${inv._id}`, { lineItems, reason: 'scope' }));
    expect(edited.total).toBe(30000);
  });
});

describe('payments, expenses and revenue', () => {
  it('records client payments, recurring bills, expenses and manual revenue', async () => {
    const direct = await admin.ok(admin.post('/clients/direct', { companyName: 'Payer Co', email: 'p@x.com', conversionValue: 50000 }));
    const vendorId = direct.vendor?._id ?? direct._id;
    const now = new Date().toISOString();

    const [, rp] = await Promise.all([
      admin.ok(admin.post('/payments/client', { vendorId, amount: 12000, method: 'bank', paidAt: now })),
      admin.ok(admin.post('/recurring-payments', { title: 'Hosting', amount: 999, frequency: 'monthly', nextDueAt: now })),
      admin.ok(admin.post('/transactions', { type: 'expense', title: 'Figma', amount: 500, category: 'tools', date: now })),
      admin.ok(admin.post('/revenue/manual', { amount: 7000, source: 'Consulting', receivedAt: now, description: 'x' })),
    ]);
    await admin.ok(admin.post(`/recurring-payments/${rp._id}/mark-paid`));

    await Promise.all(['/invoices', '/payments', '/recurring-payments', '/transactions', '/revenue', '/revenue/outstanding'].map((p) => admin.ok(admin.get(p))));
  });
});
