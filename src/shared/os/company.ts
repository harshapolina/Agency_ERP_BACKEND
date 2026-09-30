import { env } from '../../config/env.js';

/** Seller block printed on invoices. Values come from INVOICE_* env vars so bank/GST details are never hardcoded. */
export function companyProfile(organizationName?: string) {
  return {
    fromName: env.INVOICE_FROM_NAME || organizationName || 'Your Company',
    fromAddress: env.INVOICE_FROM_ADDRESS,
    fromEmail: env.INVOICE_FROM_EMAIL,
    fromPhone: env.INVOICE_FROM_PHONE,
    fromGst: env.INVOICE_FROM_GST,
    fromPan: env.INVOICE_FROM_PAN,
    fromCin: env.INVOICE_FROM_CIN,
    fromState: env.INVOICE_FROM_STATE,
    fromStateCode: env.INVOICE_FROM_STATE_CODE,
    jurisdiction: env.INVOICE_JURISDICTION,
    logoUrl: env.INVOICE_LOGO_URL,
    bankName: env.INVOICE_BANK_NAME,
    bankAccountName: env.INVOICE_BANK_ACCOUNT_NAME || env.INVOICE_FROM_NAME || organizationName || '',
    bankAccountNumber: env.INVOICE_BANK_ACCOUNT_NUMBER,
    bankIfsc: env.INVOICE_BANK_IFSC,
    bankAccountType: env.INVOICE_BANK_ACCOUNT_TYPE,
    bankUpi: env.INVOICE_BANK_UPI,
  };
}
