import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../../config/env.js';

export interface EncryptedSecret {
  cipher: string;
  iv: string;
  tag: string;
}

function keyFrom(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

function dataKey(): Buffer {
  return keyFrom(env.DATA_ENCRYPTION_KEY || env.JWT_ACCESS_SECRET);
}

function vaultKey(): Buffer {
  return keyFrom(env.PROJECT_VAULT_SECRET || env.DATA_ENCRYPTION_KEY || env.JWT_ACCESS_SECRET);
}

function encryptWith(key: Buffer, plaintext: string): EncryptedSecret | null {
  const trimmed = plaintext.trim();
  if (!trimmed) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  return {
    cipher: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptWith(key: Buffer, secret: Partial<EncryptedSecret> | undefined | null): string | null {
  if (!secret?.cipher || !secret.iv || !secret.tag) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
    d.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(secret.cipher, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const encryptData = (plaintext: string) => encryptWith(dataKey(), plaintext);
export const decryptData = (secret: Partial<EncryptedSecret> | undefined | null) => decryptWith(dataKey(), secret);

export const encryptSecret = (plaintext: string) => encryptWith(vaultKey(), plaintext);
export const decryptSecret = (secret: Partial<EncryptedSecret> | undefined | null) => decryptWith(vaultKey(), secret);

export function hasEncryptedSecret(secret: Partial<EncryptedSecret> | undefined | null) {
  return Boolean(secret?.cipher && secret.cipher.length > 0);
}

export function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function maskMongoUri(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.username ? `${url.username}:****@` : ''}${url.host}${url.pathname}`;
  } catch {
    return 'mongodb://****';
  }
}
