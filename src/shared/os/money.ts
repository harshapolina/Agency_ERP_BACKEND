import type { InvoiceStatus } from '../constants/os.js';

export const roundRupees = (n: number) => Math.round(n);

export interface TotalsInput {
  lineItems: { quantity: number; unitPrice: number; discountPercent?: number }[];
  taxRate: number;
  overallDiscount: number;
  isInterState?: boolean;
}

export function invoiceTotals(input: TotalsInput) {
  let subtotal = 0;
  let lineDiscount = 0;
  for (const item of input.lineItems) {
    const gross = (item.quantity || 0) * (item.unitPrice || 0);
    const pct = Math.max(0, Math.min(100, item.discountPercent || 0));
    subtotal += gross;
    lineDiscount += (gross * pct) / 100;
  }
  const overall = Math.max(0, input.overallDiscount || 0);
  const discount = roundRupees(lineDiscount + overall);
  const taxable = Math.max(0, roundRupees(subtotal - discount));
  const rate = Math.max(0, input.taxRate || 0);
  const isInterState = Boolean(input.isInterState);

  const igstAmount = isInterState ? roundRupees(taxable * rate) : 0;
  const cgstAmount = isInterState ? 0 : roundRupees(taxable * (rate / 2));
  const sgstAmount = isInterState ? 0 : roundRupees(taxable * (rate / 2));
  const taxAmount = igstAmount + cgstAmount + sgstAmount;

  return {
    subtotal: roundRupees(subtotal),
    discount,
    taxable,
    taxAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    total: roundRupees(taxable + taxAmount),
  };
}

export function displayInvoiceStatus(input: {
  status: string;
  dueDate?: Date | string | null;
  amountPaid: number;
  total: number;
  now?: Date;
}): InvoiceStatus {
  if (input.status === 'draft' || input.status === 'cancelled') return input.status;
  if (input.amountPaid >= input.total && input.total > 0) return 'paid';
  const now = input.now ?? new Date();
  const due = input.dueDate ? new Date(input.dueDate) : null;
  const overdue = Boolean(due && due.getTime() < now.getTime());
  if (input.amountPaid > 0 && input.amountPaid < input.total) return overdue ? 'overdue' : 'partially_paid';
  if (overdue) return 'overdue';
  return input.amountPaid > 0 ? 'partially_paid' : 'issued';
}

export const outstandingOf = (total: number, amountPaid: number) => Math.max(0, total - amountPaid);

export function withDisplayStatus<T extends { status: string; dueDate?: Date | null; amountPaid?: number; total?: number }>(inv: T) {
  return {
    ...inv,
    displayStatus: displayInvoiceStatus({
      status: inv.status === 'sent' ? 'issued' : inv.status,
      dueDate: inv.dueDate,
      amountPaid: inv.amountPaid || 0,
      total: inv.total || 0,
    }),
    outstanding: outstandingOf(inv.total || 0, inv.amountPaid || 0),
  };
}

export function numberToWordsINR(amount: number): string {
  if (isNaN(amount) || amount === 0) return 'Indian Rupee Zero Only';
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ` ${ones[n % 10]}` : ''));
  const three = (n: number) => {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    if (h && rem) return `${ones[h]} Hundred ${two(rem)}`;
    if (h) return `${ones[h]} Hundred`;
    return two(rem);
  };
  const convert = (n: number): string => {
    if (n === 0) return '';
    const parts: string[] = [];
    const crores = Math.floor(n / 10000000);
    let rem = n % 10000000;
    if (crores) parts.push(`${convert(crores)} Crore`);
    const lakhs = Math.floor(rem / 100000);
    rem %= 100000;
    if (lakhs) parts.push(`${two(lakhs)} Lakh`);
    const thousands = Math.floor(rem / 1000);
    rem %= 1000;
    if (thousands) parts.push(`${two(thousands)} Thousand`);
    if (rem) parts.push(three(rem));
    return parts.join(' ');
  };
  let result = `Indian Rupee ${convert(rupees) || 'Zero'}`;
  if (paise) result += ` and ${two(paise)} Paise`;
  result += ' Only';
  return negative ? `Minus ${result}` : result;
}

export function advanceDueDate(from: Date, frequency: string): Date {
  const next = new Date(from);
  const day = next.getDate();
  const addMonths = (m: number) => {
    next.setDate(1);
    next.setMonth(next.getMonth() + m);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  };
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (frequency === 'monthly') addMonths(1);
  else if (frequency === 'quarterly') addMonths(3);
  else addMonths(12);
  return next;
}
