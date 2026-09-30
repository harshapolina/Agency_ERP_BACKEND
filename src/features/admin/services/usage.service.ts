import mongoose, { Types, type Model } from 'mongoose';
import { Organization } from '../../../models/Organization.js';
import { User } from '../../../models/User.js';
import { connectionForOrganization, tenantModelsOn } from '../../../config/tenant.js';
import { env } from '../../../config/env.js';
import { maskMongoUri } from '../../../shared/utils/crypto.js';
import { logger } from '../../../shared/logger/index.js';
import { PLATFORM_ORG_SLUG } from '../../../shared/constants/platform.js';

export interface CollectionUsage {
  name: string;
  documents: number;
  /** Bytes of this company's documents (estimated from the collection's average document size on a shared database). */
  dataSize: number;
}

export interface DatabaseUsage {
  mode: 'dedicated' | 'shared';
  connection: string;
  dbName: string;
  users: number;
  documents: number;
  dataSize: number;
  /** Physical numbers for the whole database — only meaningful when the company has its own database. */
  database: { storageSize: number; indexSize: number; collections: number } | null;
  collections: CollectionUsage[];
  measuredAt: string;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: DatabaseUsage }>();

async function avgObjSize(model: Model<unknown>): Promise<number> {
  try {
    const [stats] = await model.collection.aggregate<{ storageStats?: { avgObjSize?: number } }>([{ $collStats: { storageStats: {} } }]).toArray();
    return stats?.storageStats?.avgObjSize || 0;
  } catch {
    return 0; // collection not created yet
  }
}

async function measure(organizationId: string): Promise<DatabaseUsage> {
  const org = await Organization.findById(organizationId).select('database.enabled database.hint database.dbName').lean();
  const conn = await connectionForOrganization(organizationId);
  const dedicated = conn !== mongoose.connection;
  const orgFilter = { organizationId: new Types.ObjectId(organizationId) };

  const [collections, users, dbStats] = await Promise.all([
    Promise.all(tenantModelsOn(conn).map(async (model) => {
      const [documents, avg] = await Promise.all([model.countDocuments(orgFilter), avgObjSize(model)]);
      return { name: model.collection.collectionName, documents, dataSize: Math.round(documents * avg) };
    })),
    User.countDocuments({ organizationId }),
    dedicated ? conn.db!.stats() : null,
  ]);

  const used = collections.filter((c) => c.documents > 0).sort((a, b) => b.dataSize - a.dataSize || b.documents - a.documents);
  return {
    mode: dedicated ? 'dedicated' : 'shared',
    connection: dedicated ? org?.database?.hint || '' : maskMongoUri(env.MONGODB_URI),
    dbName: conn.db?.databaseName || '',
    users,
    documents: used.reduce((s, c) => s + c.documents, 0),
    dataSize: used.reduce((s, c) => s + c.dataSize, 0),
    database: dbStats ? { storageSize: dbStats.storageSize, indexSize: dbStats.indexSize, collections: dbStats.collections } : null,
    collections: used,
    measuredAt: new Date().toISOString(),
  };
}

export async function databaseUsage(organizationId: string, fresh = false): Promise<DatabaseUsage> {
  const hit = cache.get(organizationId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await measure(organizationId);
  cache.set(organizationId, { at: Date.now(), value });
  return value;
}

/** Headline numbers for every company, for the platform Companies list. Failures (e.g. an unreachable database) are reported per company. */
export async function allDatabaseUsage() {
  const orgs = await Organization.find({ slug: { $ne: PLATFORM_ORG_SLUG } }).select('_id').lean();
  return Promise.all(orgs.map(async (o) => {
    const id = String(o._id);
    try {
      const u = await databaseUsage(id);
      return { organizationId: id, mode: u.mode, dbName: u.dbName, users: u.users, documents: u.documents, dataSize: u.dataSize, storageSize: u.database?.storageSize ?? null, error: '' };
    } catch (error) {
      logger.warn('Usage measurement failed', { organizationId: id, error: (error as Error).message });
      return { organizationId: id, mode: 'dedicated' as const, dbName: '', users: 0, documents: 0, dataSize: 0, storageSize: null, error: 'Database unreachable' };
    }
  }));
}

export function forgetUsage(organizationId: string) {
  cache.delete(organizationId);
}
