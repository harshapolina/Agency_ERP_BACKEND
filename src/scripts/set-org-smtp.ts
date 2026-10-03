/**
 * Apply platform SMTP credentials onto one or more organizations.
 *
 *   npx tsx src/scripts/set-org-smtp.ts
 *   npx tsx src/scripts/set-org-smtp.ts --slugs editco-media,agency-erp-platform
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Organization } from '../models/Organization.js';
import { encryptData } from '../shared/utils/crypto.js';
import { PLATFORM_ORG_SLUG } from '../shared/constants/platform.js';

const DEFAULT_SLUGS = ['editco-media', PLATFORM_ORG_SLUG];

function argSlugs() {
  const i = process.argv.indexOf('--slugs');
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_SLUGS;
}

async function main() {
  if (!env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS must be set in .env');
  }
  const enc = encryptData(env.SMTP_PASS);
  if (!enc) throw new Error('Could not encrypt SMTP password — check DATA_ENCRYPTION_KEY');

  await mongoose.connect(env.MONGODB_URI);
  const slugs = argSlugs();
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = env.SMTP_PORT || 465;
  const fromEmail = (env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] || env.SMTP_USER).toLowerCase();
  const fromName = env.EMAIL_FROM?.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '') || 'Editco Media';

  for (const slug of slugs) {
    const org = await Organization.findOneAndUpdate(
      { slug },
      {
        $set: {
          'smtp.enabled': true,
          'smtp.host': host,
          'smtp.port': port,
          'smtp.secure': port === 465,
          'smtp.user': env.SMTP_USER.toLowerCase(),
          'smtp.fromName': fromName,
          'smtp.fromEmail': fromEmail,
          'smtp.passCipher': enc.cipher,
          'smtp.passIv': enc.iv,
          'smtp.passTag': enc.tag,
          'smtp.updatedBy': 'set-org-smtp',
          'smtp.updatedAt': new Date(),
        },
      },
      { new: true }
    ).select('name slug smtp.enabled smtp.user smtp.fromEmail');
    if (!org) {
      console.warn(`Organization not found: ${slug}`);
      continue;
    }
    console.log(`SMTP enabled for ${org.name} (${org.slug}) → ${org.smtp?.user}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
