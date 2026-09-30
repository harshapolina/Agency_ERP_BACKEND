import { Router } from 'express';
import { z } from 'zod';
import { Organization } from '../../../models/Organization.js';
import { route, parseBody, isObjectId } from '../../../shared/utils/crud.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { encryptData, maskMongoUri } from '../../../shared/utils/crypto.js';
import { connectionForOrganization, invalidateOrganizationConnection, testMongoConnection, tenantDatabaseStatus } from '../../../config/tenant.js';

/** Mounted under `/admin/organizations/:id/database` (super admin only). The URI is write-only. */
export const organizationDatabaseRoutes = Router({ mergeParams: true });

const uriSchema = z.object({
  uri: z.string().trim().regex(/^mongodb(\+srv)?:\/\//, 'Must be a mongodb:// or mongodb+srv:// connection string'),
  dbName: z.string().trim().regex(/^[A-Za-z0-9_-]{1,63}$/, 'Database name may only contain letters, numbers, - and _').optional().or(z.literal('')),
});

async function loadOrg(id: string) {
  if (!isObjectId(id)) throw new NotFoundError('Organization');
  const org = await Organization.findById(id).select('name slug database');
  if (!org) throw new NotFoundError('Organization');
  return org;
}

function publicDatabase(org: { _id: unknown; database?: Record<string, unknown> }) {
  const db = org.database || {};
  return {
    enabled: Boolean(db.enabled),
    dbName: db.dbName || '',
    hint: db.hint || '',
    status: db.status || 'unconfigured',
    lastCheckedAt: db.lastCheckedAt || null,
    lastError: db.lastError || '',
    runtime: tenantDatabaseStatus(String(org._id)),
  };
}

async function probe(uri: string, dbName?: string) {
  try {
    return await testMongoConnection(uri, dbName || undefined);
  } catch (error) {
    const message = (error as Error).message || 'Connection failed';
    // Never echo credentials back from driver errors.
    throw new ValidationError(`Could not connect: ${message.replace(/\/\/[^@\s]+@/g, '//****@')}`);
  }
}

organizationDatabaseRoutes.get(
  '/',
  route(async (req) => publicDatabase((await loadOrg(req.params.id as string)).toObject()))
);

organizationDatabaseRoutes.post(
  '/test',
  route(async (req) => {
    const org = await loadOrg(req.params.id as string);
    const body = parseBody<z.infer<typeof uriSchema>>(uriSchema, req.body);
    const result = await probe(body.uri, body.dbName || org.slug);
    return { ...result, hint: maskMongoUri(body.uri) };
  })
);

organizationDatabaseRoutes.put(
  '/',
  route(async (req) => {
    const org = await loadOrg(req.params.id as string);
    const body = parseBody<z.infer<typeof uriSchema>>(uriSchema, req.body);
    const dbName = body.dbName || org.slug;
    await probe(body.uri, dbName);
    const enc = encryptData(body.uri)!;
    await Organization.updateOne(
      { _id: org._id },
      {
        $set: {
          'database.enabled': true, 'database.uriCipher': enc.cipher, 'database.uriIv': enc.iv, 'database.uriTag': enc.tag,
          'database.dbName': dbName, 'database.hint': maskMongoUri(body.uri), 'database.status': 'connected',
          'database.lastCheckedAt': new Date(), 'database.lastError': '', 'database.updatedBy': req.user!.email,
        },
      }
    );
    await invalidateOrganizationConnection(String(org._id));
    return publicDatabase((await loadOrg(String(org._id))).toObject());
  })
);

organizationDatabaseRoutes.post(
  '/check',
  route(async (req) => {
    const org = await Organization.findById(req.params.id).select('+database.uriCipher +database.uriIv +database.uriTag');
    if (!org) throw new NotFoundError('Organization');
    if (!org.database?.enabled) throw new ValidationError('No dedicated database configured');
    let status: 'connected' | 'error' = 'connected';
    let lastError = '';
    try {
      await invalidateOrganizationConnection(String(org._id));
      const conn = await connectionForOrganization(String(org._id));
      await conn.db!.admin().ping();
    } catch (error) {
      status = 'error';
      lastError = ((error as Error).message || 'Connection failed').replace(/\/\/[^@\s]+@/g, '//****@');
    }
    await Organization.updateOne({ _id: org._id }, { $set: { 'database.status': status, 'database.lastCheckedAt': new Date(), 'database.lastError': lastError } });
    return publicDatabase((await loadOrg(String(org._id))).toObject());
  })
);

organizationDatabaseRoutes.delete(
  '/',
  route(async (req) => {
    const org = await loadOrg(req.params.id as string);
    await Organization.updateOne(
      { _id: org._id },
      {
        $set: { 'database.enabled': false, 'database.status': 'unconfigured', 'database.hint': '', 'database.lastError': '', 'database.updatedBy': req.user!.email },
        $unset: { 'database.uriCipher': 1, 'database.uriIv': 1, 'database.uriTag': 1 },
      }
    );
    await invalidateOrganizationConnection(String(org._id));
    return publicDatabase((await loadOrg(String(org._id))).toObject());
  })
);
