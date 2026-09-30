import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose, { type Connection, type Model, Schema, type SchemaType } from 'mongoose';
import { Organization } from '../models/Organization.js';
import { decryptData, sha256Hex } from '../shared/utils/crypto.js';
import { logger } from '../shared/logger/index.js';

/**
 * Multi-database tenancy.
 *
 * Core collections (organizations, users, sessions, tokens, platform settings…) always live in the
 * main database. Every business collection is registered through `tenantModel`, which resolves to the
 * connection of the organization handling the current request. Organizations without a dedicated
 * database fall back to the main connection.
 */

interface TenantStore {
  organizationId?: string;
  connection: Connection;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

const CORE_MODEL_NAMES = new Set(['User', 'Organization']);
const registry = new Map<string, Schema>();
const registeredCount = new WeakMap<Connection, number>();

export function currentConnection(): Connection {
  return tenantStorage.getStore()?.connection ?? mongoose.connection;
}

export function currentOrganizationId(): string | undefined {
  return tenantStorage.getStore()?.organizationId;
}

function pointRefsAtCoreModels(schema: Schema) {
  const fix = (type: SchemaType & { caster?: SchemaType; options: Record<string, unknown> }) => {
    const ref = type.options?.ref;
    if (typeof ref === 'string' && CORE_MODEL_NAMES.has(ref)) type.options.ref = mongoose.model(ref);
    const casterRef = type.caster?.options?.ref;
    if (typeof casterRef === 'string' && CORE_MODEL_NAMES.has(casterRef)) {
      (type.caster as SchemaType & { options: Record<string, unknown> }).options.ref = mongoose.model(casterRef);
    }
  };
  schema.eachPath((_path, type) => fix(type as never));
  for (const child of schema.childSchemas) pointRefsAtCoreModels(child.schema);
}

function ensureRegistered(conn: Connection) {
  if (registeredCount.get(conn) === registry.size) return;
  const isMain = conn === mongoose.connection;
  for (const [name, schema] of registry) {
    if (conn.models[name]) continue;
    let target = schema;
    if (!isMain) {
      target = schema.clone();
      pointRefsAtCoreModels(target);
    }
    conn.model(name, target);
  }
  registeredCount.set(conn, registry.size);
}

function modelOn<T>(conn: Connection, name: string): Model<T> {
  ensureRegistered(conn);
  return conn.models[name] as Model<T>;
}

/** Registers a business model whose data lives in the current organization's database. */
export function tenantModel<T>(name: string, schema: Schema<T>): Model<T> {
  registry.set(name, schema as Schema);
  const resolve = () => modelOn<T>(currentConnection(), name);
  const target = function TenantModel() {} as unknown as object;

  return new Proxy(target, {
    get(_t, prop) {
      const model = resolve() as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(model, prop, model);
      return typeof value === 'function' && prop !== 'prototype'
        ? (value as (...args: unknown[]) => unknown).bind(model)
        : value;
    },
    set(_t, prop, value) {
      Reflect.set(resolve() as object, prop, value);
      return true;
    },
    construct(_t, args) {
      const M = resolve() as unknown as new (...a: unknown[]) => object;
      return new M(...args);
    },
  }) as Model<T>;
}

// ---------------------------------------------------------------------------
// Organization → connection resolution
// ---------------------------------------------------------------------------

interface CachedConnection {
  key: string;
  conn: Connection;
}

interface CachedOrgConfig {
  expiresAt: number;
  uri?: string;
  dbName?: string;
}

const connections = new Map<string, CachedConnection>();
const pending = new Map<string, Promise<Connection>>();
const orgConfigCache = new Map<string, CachedOrgConfig>();
const ORG_CACHE_MS = 30_000;

async function orgDatabaseConfig(organizationId: string): Promise<CachedOrgConfig> {
  const cached = orgConfigCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const org = await Organization.findById(organizationId)
    .select('+database.uriCipher +database.uriIv +database.uriTag')
    .lean();

  const db = org?.database;
  const config: CachedOrgConfig = { expiresAt: Date.now() + ORG_CACHE_MS };
  if (db?.enabled && db.uriCipher) {
    const uri = decryptData({ cipher: db.uriCipher, iv: db.uriIv, tag: db.uriTag });
    if (uri) {
      config.uri = uri;
      config.dbName = db.dbName || undefined;
    } else {
      logger.error('Could not decrypt organization database URI', { organizationId });
    }
  }
  orgConfigCache.set(organizationId, config);
  return config;
}

async function openConnection(uri: string, dbName?: string): Promise<Connection> {
  // Index builds for ~70 models would otherwise stall the first requests on a new tenant database.
  const conn = mongoose.createConnection(uri, {
    dbName,
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
    autoIndex: false,
    autoCreate: false,
  });
  await conn.asPromise();
  return conn;
}

async function buildIndexes(conn: Connection, organizationId: string) {
  const results = await Promise.allSettled(Object.values(conn.models).map((m) => m.createIndexes()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) {
    logger.error('Tenant index build failed', { organizationId, failed: failed.length, reason: String(failed[0].reason) });
  }
}

export async function connectionForOrganization(organizationId?: string): Promise<Connection> {
  if (!organizationId) return mongoose.connection;
  const config = await orgDatabaseConfig(organizationId);
  if (!config.uri) return mongoose.connection;

  const key = sha256Hex(`${config.uri}|${config.dbName || ''}`);
  const existing = connections.get(organizationId);
  if (existing && existing.key === key && existing.conn.readyState === 1) return existing.conn;

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    if (existing) await existing.conn.close().catch(() => undefined);
    const conn = await openConnection(config.uri!, config.dbName);
    ensureRegistered(conn);
    if (mongoose.get('autoIndex') !== false) void buildIndexes(conn, organizationId);
    connections.set(organizationId, { key, conn });
    logger.info('Tenant database connected', { organizationId });
    return conn;
  })().finally(() => pending.delete(key));

  pending.set(key, promise);
  return promise;
}

export async function invalidateOrganizationConnection(organizationId: string) {
  orgConfigCache.delete(organizationId);
  const existing = connections.get(organizationId);
  if (existing) {
    connections.delete(organizationId);
    await existing.conn.close().catch(() => undefined);
  }
}

export async function testMongoConnection(uri: string, dbName?: string) {
  const started = Date.now();
  const conn = await openConnection(uri, dbName);
  try {
    await conn.db!.admin().ping();
    return { ok: true as const, latencyMs: Date.now() - started, dbName: conn.db!.databaseName };
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export async function runWithOrganization<R>(organizationId: string, fn: () => Promise<R>): Promise<R> {
  const connection = await connectionForOrganization(organizationId);
  return tenantStorage.run({ organizationId, connection }, fn);
}

export function tenantDatabaseStatus(organizationId: string) {
  const existing = connections.get(organizationId);
  if (!existing) return 'shared' as const;
  return existing.conn.readyState === 1 ? ('connected' as const) : ('disconnected' as const);
}
