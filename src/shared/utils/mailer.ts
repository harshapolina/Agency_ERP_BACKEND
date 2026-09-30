import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger/index.js';

let transporter: Transporter | null = null;

export function isMailConfigured() {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter(): Transporter | null {
  if (!isMailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
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

export async function sendMail(to: string | string[], subject: string, html: string): Promise<boolean> {
  const recipients = (Array.isArray(to) ? to : [to]).map((t) => t.trim()).filter(Boolean);
  if (!recipients.length) return false;
  const t = getTransporter();
  if (!t) {
    logger.debug('Email skipped (SMTP not configured)', { subject, to: recipients });
    return false;
  }
  try {
    await t.sendMail({ from: env.EMAIL_FROM || env.SMTP_USER, to: recipients.join(','), subject, html });
    return true;
  } catch (error) {
    logger.error('Email send failed', { subject, error: (error as Error).message });
    return false;
  }
}

export function sendNotificationEmail(to: string | string[], email: NotificationEmail, subject = email.title) {
  return sendMail(to, subject, renderNotificationEmail(email));
}
