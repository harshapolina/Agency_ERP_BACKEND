import { randomBytes } from 'crypto';
import { Organization, PortalAccess } from '../../../models/index.js';
import { decryptData, encryptData, sha256Hex } from '../../../shared/utils/crypto.js';
import { env } from '../../../config/env.js';
import type { Actor } from '../../../shared/os/activity.js';

async function portalPath(organizationId: string, token: string) {
  const org = await Organization.findById(organizationId).select('slug').lean();
  return `/portal/${org?.slug}/${token}`;
}

/** Issues a fresh token for a conversion, replacing any previous one. */
export async function rotatePortalToken(actor: Actor, conversionUuid: string) {
  const token = randomBytes(24).toString('base64url');
  const enc = encryptData(token)!;
  await PortalAccess.findOneAndUpdate(
    { organizationId: actor.organizationId, conversionUuid },
    {
      $set: {
        tokenHash: sha256Hex(token), tokenHint: token.slice(-6), tokenCipher: enc.cipher, tokenIv: enc.iv, tokenTag: enc.tag,
        isActive: true, updatedBy: actor.email,
      },
      $setOnInsert: { createdBy: actor.email },
    },
    { upsert: true, new: true }
  );
  const path = await portalPath(actor.organizationId, token);
  return { token, path, url: `${env.APP_URL}${path}` };
}

/** Reuses the active portal link when possible so links already sent to the client keep working. */
export async function ensurePortalActive(actor: Actor, conversionUuid: string) {
  const existing = await PortalAccess.findOne({ organizationId: actor.organizationId, conversionUuid })
    .select('+tokenCipher +tokenIv +tokenTag')
    .lean();
  const token = existing?.isActive ? decryptData({ cipher: existing.tokenCipher, iv: existing.tokenIv, tag: existing.tokenTag }) : null;
  if (!token) return rotatePortalToken(actor, conversionUuid);
  const path = await portalPath(actor.organizationId, token);
  return { token, path, url: `${env.APP_URL}${path}` };
}
