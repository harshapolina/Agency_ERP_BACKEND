import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { currentOrganizationId } from '../../config/tenant.js';
import { Organization } from '../../models/Organization.js';
import { decryptData } from './crypto.js';
import { logger } from '../logger/index.js';

export interface SendMailOpts {
  organizationId?: string;
}

interface ResolvedSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

async function resolveSmtp(organizationId?: string): Promise<ResolvedSmtp | null> {
  const orgId = organizationId || currentOrganizationId();
  if (orgId) {
    const org = await Organization.findById(orgId)
      .select('name smtp.enabled smtp.host smtp.port smtp.secure smtp.user smtp.fromName smtp.fromEmail +smtp.passCipher +smtp.passIv +smtp.passTag')
      .lean();
    const smtp = org?.smtp;
    if (smtp?.enabled && smtp.user) {
      const pass = decryptData({ cipher: smtp.passCipher, iv: smtp.passIv, tag: smtp.passTag });
      if (pass) {
        const host = (smtp.host || 'smtp.gmail.com').trim();
        const port = Number(smtp.port) || 465;
        const fromEmail = (smtp.fromEmail || smtp.user).trim();
        const fromName = (smtp.fromName || org?.name || '').trim().replace(/"/g, '');
        return {
          host,
          port,
          secure: smtp.secure ?? port === 465,
          user: smtp.user.trim(),
          pass,
          from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
        };
      }
    }
  }

  if (env.SMTP_USER && env.SMTP_PASS) {
    return {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.EMAIL_FROM || env.SMTP_USER,
    };
  }
  return null;
}

/** True when company SMTP (preferred) or server env SMTP is available. */
export async function isMailConfigured(organizationId?: string) {
  return Boolean(await resolveSmtp(organizationId));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface NotificationEmail {
  title: string;
  body?: string;
  href?: string;
  eyebrow?: string;
  lines?: string[];
  ctaLabel?: string;
}

export function renderNotificationEmail({ title, body, href, eyebrow = 'Editco OS', lines = [], ctaLabel = 'Open in Editco OS →' }: NotificationEmail) {
  const url = href ? (href.startsWith('http') ? href : `${env.APP_URL.replace(/\/$/, '')}${href}`) : '';
  const list = lines.length
    ? `<ul style="padding-left:18px;margin:12px 0;color:#374151;font-size:14px;line-height:1.6">${lines
        .map((l) => `<li>${escapeHtml(l)}</li>`)
        .join('')}</ul>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="padding:20px 24px;background:#0d0d0d;color:#c8f542;font-size:12px;letter-spacing:.12em;text-transform:uppercase">${escapeHtml(eyebrow)}</div>
    <div style="padding:24px">
      <h1 style="margin:0 0 8px;font-size:20px;color:#111827">${escapeHtml(title)}</h1>
      ${body ? `<p style="margin:0;color:#4b5563;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(body)}</p>` : ''}
      ${list}
      ${url ? `<a href="${url}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#111827;color:#fff;border-radius:999px;text-decoration:none;font-size:14px">${escapeHtml(ctaLabel)}</a>` : ''}
    </div>
  </div></body></html>`;
}

async function sendWithConfig(cfg: ResolvedSmtp, to: string[], subject: string, html: string) {
  let transporter: Transporter | null = null;
  try {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transporter.sendMail({ from: cfg.from, to: to.join(','), subject, html });
    return true;
  } catch (error) {
    logger.error('Email send failed', { subject, error: (error as Error).message });
    return false;
  } finally {
    transporter?.close();
  }
}

export async function sendMail(to: string | string[], subject: string, html: string, opts?: SendMailOpts): Promise<boolean> {
  const recipients = (Array.isArray(to) ? to : [to]).map((t) => t.trim()).filter(Boolean);
  if (!recipients.length) return false;
  const cfg = await resolveSmtp(opts?.organizationId);
  if (!cfg) {
    logger.debug('Email skipped (SMTP not configured)', { subject, to: recipients });
    return false;
  }
  return sendWithConfig(cfg, recipients, subject, html);
}

export function sendNotificationEmail(
  to: string | string[],
  email: NotificationEmail,
  subject = email.title,
  opts?: SendMailOpts
) {
  return sendMail(to, subject, renderNotificationEmail(email), opts);
}
