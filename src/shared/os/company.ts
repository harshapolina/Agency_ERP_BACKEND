import { z } from 'zod';
import { Organization } from '../../models/Organization.js';
import { COMPANY_PROFILE_FIELDS, NOTIFICATION_CATEGORIES, type NotificationCategory } from '../constants/os.js';
import { encryptData, hasEncryptedSecret } from '../utils/crypto.js';

export interface CompanyRecord {
  name?: string;
  logo?: string;
  profile?: Partial<Record<(typeof COMPANY_PROFILE_FIELDS)[number], string>>;
}

export const COMPANY_SELECT = 'name slug logo website industry profile notificationEmails smtp.enabled smtp.host smtp.port smtp.secure smtp.user smtp.fromName smtp.fromEmail';
export const COMPANY_SMTP_SELECT = `${COMPANY_SELECT} +smtp.passCipher +smtp.passIv +smtp.passTag`;

/** Seller block printed on invoices, taken from the company's own profile so tenants never see each other's GST or bank details. */
export function companyProfile(org?: CompanyRecord | null) {
  const p = org?.profile || {};
  const name = p.legalName || org?.name || 'Your Company';
  return {
    fromName: name,
    fromAddress: p.address || '',
    fromEmail: p.email || '',
    fromPhone: p.phone || '',
    fromGst: p.gst || '',
    fromPan: p.pan || '',
    fromCin: p.cin || '',
    fromState: p.state || '',
    fromStateCode: p.stateCode || '',
    jurisdiction: p.jurisdiction || '',
    logoUrl: org?.logo || '',
    bankName: p.bankName || '',
    bankAccountName: p.bankAccountName || name,
    bankAccountNumber: p.bankAccountNumber || '',
    bankIfsc: p.bankIfsc || '',
    bankAccountType: p.bankAccountType || '',
    bankUpi: p.bankUpi || '',
  };
}

export async function loadCompany(organizationId: string) {
  return Organization.findById(organizationId).select(COMPANY_SELECT).lean<CompanyRecord & { notificationEmails?: Partial<Record<NotificationCategory, string[]>> }>();
}

export async function notificationRecipients(organizationId: string, category: NotificationCategory): Promise<string[]> {
  const org = await Organization.findById(organizationId).select(`notificationEmails.${category}`).lean();
  return org?.notificationEmails?.[category] ?? [];
}

// ---------------------------------------------------------------- validation

const MAX_LOGO_BYTES = 300_000;
const LOGO_PATTERN = /^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+|https:\/\/\S+)$/;

export const logoSchema = z
  .string()
  .max(MAX_LOGO_BYTES, 'Logo is too large — use an image under 200 KB')
  .refine((v) => v === '' || LOGO_PATTERN.test(v), 'Logo must be a PNG, JPEG or WebP image, or an https:// URL');

export const companyProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  website: z.string().trim().max(300).optional(),
  industry: z.string().trim().max(100).optional(),
  logo: logoSchema.optional(),
  profile: z
    .object(Object.fromEntries(COMPANY_PROFILE_FIELDS.map((f) => [f, z.string().trim().max(f === 'address' ? 1000 : 200).optional()])))
    .partial()
    .optional(),
});

const emailList = z
  .array(z.string().trim().toLowerCase().email('Enter valid email addresses'))
  .max(20, 'Up to 20 addresses per category')
  .transform((list) => [...new Set(list)]);

export const notificationEmailsSchema = z.object(
  Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, emailList.optional()])) as Record<NotificationCategory, z.ZodOptional<typeof emailList>>
);

/** Flattens a validated profile payload into `$set` paths so partial updates never wipe other fields. */
export function companyUpdate(input: z.infer<typeof companyProfileSchema>) {
  const set: Record<string, unknown> = {};
  for (const key of ['name', 'website', 'industry', 'logo'] as const) if (input[key] !== undefined) set[key] = input[key];
  for (const [key, value] of Object.entries(input.profile || {})) if (value !== undefined) set[`profile.${key}`] = value;
  return set;
}

export function notificationEmailsUpdate(input: z.infer<typeof notificationEmailsSchema>) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [`notificationEmails.${k}`, v]));
}

export function publicCompany(org: CompanyRecord & { website?: string; industry?: string; slug?: string }) {
  return {
    name: org.name || '',
    slug: org.slug || '',
    website: org.website || '',
    industry: org.industry || '',
    logo: org.logo || '',
    profile: Object.fromEntries(COMPANY_PROFILE_FIELDS.map((f) => [f, org.profile?.[f] || ''])),
  };
}

export function publicNotificationEmails(org: { notificationEmails?: Partial<Record<NotificationCategory, string[]>> }) {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, org.notificationEmails?.[c] ?? []])) as Record<NotificationCategory, string[]>;
}

export type SmtpRecord = {
  smtp?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    fromName?: string;
    fromEmail?: string;
    passCipher?: string;
    passIv?: string;
    passTag?: string;
  };
};

export function publicSmtp(org: SmtpRecord) {
  const s = org.smtp || {};
  return {
    enabled: Boolean(s.enabled),
    host: s.host || 'smtp.gmail.com',
    port: Number(s.port) || 465,
    secure: s.secure ?? true,
    user: s.user || '',
    fromName: s.fromName || '',
    fromEmail: s.fromEmail || '',
    passwordConfigured: hasEncryptedSecret({ cipher: s.passCipher, iv: s.passIv, tag: s.passTag }),
  };
}

export const smtpSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(200).default('smtp.gmail.com'),
  port: z.coerce.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  user: z.string().trim().email('Enter a valid mailbox / SMTP username'),
  fromName: z.string().trim().max(200).optional().default(''),
  fromEmail: z.union([z.literal(''), z.string().trim().email()]).optional().default(''),
  password: z.union([z.literal(''), z.string().trim().min(4).max(200)]).optional().default(''),
});

/** Builds `$set` for SMTP; password is encrypted and only written when provided. */
export function smtpSettingsUpdate(input: z.infer<typeof smtpSettingsSchema>, actorEmail: string, alreadyConfigured: boolean) {
  const set: Record<string, unknown> = {
    'smtp.enabled': input.enabled,
    'smtp.host': input.host,
    'smtp.port': input.port,
    'smtp.secure': input.secure,
    'smtp.user': input.user.toLowerCase(),
    'smtp.fromName': input.fromName || '',
    'smtp.fromEmail': (input.fromEmail || input.user).toLowerCase(),
    'smtp.updatedBy': actorEmail,
    'smtp.updatedAt': new Date(),
  };
  const password = (input.password || '').trim();
  if (password) {
    const enc = encryptData(password);
    if (!enc) throw new Error('Could not encrypt SMTP password');
    set['smtp.passCipher'] = enc.cipher;
    set['smtp.passIv'] = enc.iv;
    set['smtp.passTag'] = enc.tag;
  } else if (input.enabled && !alreadyConfigured) {
    throw new Error('App password is required when enabling SMTP');
  }
  return set;
}
