import dotenv from 'dotenv';
import { z } from 'zod';

// Tests supply their own environment so a developer's .env (real database, SMTP) can never leak in.
if (process.env.NODE_ENV !== 'test') dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  UPLOAD_DIR: z.string().default('./uploads'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  PROJECT_VAULT_SECRET: z.string().optional(),
  APP_URL: z.string().default('http://localhost:3000'),
  CRON_SECRET: z.string().optional(),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  FINANCE_ALERT_EMAILS: z.string().default(''),
  INVOICE_FROM_NAME: z.string().optional(),
  INVOICE_FROM_ADDRESS: z.string().default(''),
  INVOICE_FROM_EMAIL: z.string().default(''),
  INVOICE_FROM_PHONE: z.string().default(''),
  INVOICE_FROM_GST: z.string().default(''),
  INVOICE_FROM_PAN: z.string().default(''),
  INVOICE_FROM_CIN: z.string().default(''),
  INVOICE_FROM_STATE: z.string().default('Karnataka'),
  INVOICE_FROM_STATE_CODE: z.string().default('29'),
  INVOICE_JURISDICTION: z.string().default('Bengaluru'),
  INVOICE_LOGO_URL: z.string().default(''),
  INVOICE_BANK_NAME: z.string().default(''),
  INVOICE_BANK_ACCOUNT_NAME: z.string().default(''),
  INVOICE_BANK_ACCOUNT_NUMBER: z.string().default(''),
  INVOICE_BANK_IFSC: z.string().default(''),
  INVOICE_BANK_ACCOUNT_TYPE: z.string().default('Current Account'),
  INVOICE_BANK_UPI: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
