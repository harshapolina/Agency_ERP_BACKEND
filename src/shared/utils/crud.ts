import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { Types, type Model, type PopulateOptions } from 'mongoose';
import type { ZodTypeAny } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { NotFoundError, ValidationError } from '../errors/index.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { actorFrom, logActivity, type Actor } from '../os/activity.js';
import type { OsDoc } from '../../models/os/base.js';

export type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown> | unknown;

/** Wraps an async handler; a returned value is sent as `{ success, data }`. */
export function route(fn: Handler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res))
      .then((result) => {
        if (res.headersSent) return;
        if (result && typeof result === 'object' && 'pagination' in (result as object)) {
          res.json({ success: true, ...(result as object) });
        } else {
          res.json({ success: true, data: result ?? null });
        }
      })
      .catch(next);
  };
}

export function parseBody<T>(schema: ZodTypeAny, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ValidationError(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', result.error.flatten());
  }
  return result.data as T;
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function oid(id: string) {
  return new Types.ObjectId(id);
}

export function isObjectId(id: unknown): id is string {
  return typeof id === 'string' && Types.ObjectId.isValid(id);
}

const PROTECTED_KEYS = ['_id', 'organizationId', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', '__v'];

export function cleanInput(data: Record<string, unknown>, extraProtected: string[] = []) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (PROTECTED_KEYS.includes(k) || extraProtected.includes(k)) continue;
    out[k] = v === '' && (k.endsWith('Id') || k.endsWith('At') || k.endsWith('Date')) ? undefined : v;
  }
  return out;
}

export interface CrudContext {
  req: AuthenticatedRequest;
  actor: Actor;
  organizationId: string;
}

export interface CrudOptions {
  model: Model<OsDoc>;
  resource: string;
  entityType: string;
  label: string;
  searchFields?: string[];
  filterFields?: string[];
  dateField?: string;
  populate?: string | PopulateOptions | (string | PopulateOptions)[];
  defaultSort?: Record<string, 1 | -1>;
  createSchema?: ZodTypeAny;
  updateSchema?: ZodTypeAny;
  readPermission?: string;
  writePermission?: string;
  deletePermission?: string;
  hardDelete?: boolean;
  hasRecordStatus?: boolean;
  /** Legacy models store `createdBy` as a User ObjectId instead of an email. */
  actorAsUserId?: boolean;
  titleOf?: (doc: OsDoc) => string;
  scope?: (ctx: CrudContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  prepare?: (data: Record<string, unknown>, ctx: CrudContext, existing?: OsDoc) => Promise<Record<string, unknown>> | Record<string, unknown>;
  afterCreate?: (doc: OsDoc, ctx: CrudContext) => Promise<void> | void;
  afterUpdate?: (doc: OsDoc, prev: OsDoc, ctx: CrudContext) => Promise<void> | void;
  transform?: (doc: OsDoc, ctx: CrudContext) => OsDoc;
  extend?: (router: Router) => void;
}

function ctxOf(req: AuthenticatedRequest): CrudContext {
  return { req, actor: actorFrom(req.user!), organizationId: req.user!.organizationId };
}

export function crudRouter(opts: CrudOptions): Router {
  const router = Router();
  const read = opts.readPermission ?? `${opts.resource}:read`;
  const write = opts.writePermission ?? `${opts.resource}:write`;
  const del = opts.deletePermission ?? write;
  const hasRecordStatus = opts.hasRecordStatus !== false;
  const titleOf = opts.titleOf ?? ((d: OsDoc) => String(d.name ?? d.title ?? d._id));
  const transform = (doc: OsDoc, ctx: CrudContext) => (opts.transform ? opts.transform(doc, ctx) : doc);

  router.use(authenticate);

  async function baseFilter(ctx: CrudContext) {
    const filter: Record<string, unknown> = { organizationId: oid(ctx.organizationId) };
    if (hasRecordStatus) filter.recordStatus = { $ne: 'archived' };
    if (opts.scope) Object.assign(filter, await opts.scope(ctx));
    return filter;
  }

  opts.extend?.(router);

  router.get(
    '/',
    authorize(read),
    route(async (req) => {
      const ctx = ctxOf(req);
      const q = req.query as Record<string, string>;
      const filter = await baseFilter(ctx);
      if (hasRecordStatus && q.recordStatus === 'archived') filter.recordStatus = 'archived';

      for (const field of opts.filterFields ?? []) {
        const value = q[field];
        if (value === undefined || value === '' || value === 'all') continue;
        if (value.includes(',')) filter[field] = { $in: value.split(',') };
        else if (value === 'true' || value === 'false') filter[field] = value === 'true';
        else filter[field] = field.endsWith('Id') && isObjectId(value) ? oid(value) : value;
      }
      if (opts.dateField && (q.from || q.to)) {
        const range: Record<string, Date> = {};
        if (q.from) range.$gte = new Date(q.from);
        if (q.to) range.$lte = new Date(q.to);
        filter[opts.dateField] = range;
      }
      if (q.search?.trim() && opts.searchFields?.length) {
        const rx = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
        filter.$or = opts.searchFields.map((f) => ({ [f]: rx }));
      }

      const page = Math.max(1, Number(q.page) || 1);
      const limit = q.all === 'true' ? 1000 : Math.min(200, Math.max(1, Number(q.limit) || 50));
      const sort = q.sort ? { [q.sort]: q.order === 'asc' ? 1 : -1 } : opts.defaultSort ?? { createdAt: -1 };

      let query = opts.model.find(filter).sort(sort as Record<string, 1 | -1>).skip((page - 1) * limit).limit(limit);
      if (opts.populate) query = query.populate(opts.populate as never);
      const [data, total] = await Promise.all([query.lean(), opts.model.countDocuments(filter)]);
      const totalPages = Math.ceil(total / limit) || 1;
      return {
        data: (data as OsDoc[]).map((d) => transform(d, ctx)),
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      };
    })
  );

  router.get(
    '/:id',
    authorize(read),
    route(async (req) => {
      const ctx = ctxOf(req);
      if (!isObjectId(req.params.id)) throw new NotFoundError(opts.label);
      const filter = { ...(await baseFilter(ctx)), _id: oid(req.params.id as string) };
      if (hasRecordStatus) delete (filter as Record<string, unknown>).recordStatus;
      let query = opts.model.findOne(filter);
      if (opts.populate) query = query.populate(opts.populate as never);
      const doc = await query.lean();
      if (!doc) throw new NotFoundError(opts.label);
      return transform(doc as OsDoc, ctx);
    })
  );

  router.post(
    '/',
    authorize(write),
    route(async (req, res) => {
      const ctx = ctxOf(req);
      let data = cleanInput(opts.createSchema ? parseBody(opts.createSchema, req.body) : req.body);
      if (opts.prepare) data = await opts.prepare(data, ctx);
      const doc = await opts.model.create({
        ...data,
        organizationId: ctx.organizationId,
        createdBy: opts.actorAsUserId ? ctx.actor.userId : ctx.actor.email,
        updatedBy: ctx.actor.email,
      });
      const plain = doc.toObject() as OsDoc;
      await logActivity(ctx.actor, { title: `${opts.label} created`, detail: titleOf(plain), entityType: opts.entityType, entityId: String(plain._id) });
      await opts.afterCreate?.(plain, ctx);
      res.status(201);
      return transform(plain, ctx);
    })
  );

  router.patch(
    '/:id',
    authorize(write),
    route(async (req) => {
      const ctx = ctxOf(req);
      if (!isObjectId(req.params.id)) throw new NotFoundError(opts.label);
      const filter = { ...(await baseFilter(ctx)), _id: oid(req.params.id as string) };
      if (hasRecordStatus) delete (filter as Record<string, unknown>).recordStatus;
      const existing = (await opts.model.findOne(filter).lean()) as OsDoc | null;
      if (!existing) throw new NotFoundError(opts.label);
      let data = cleanInput(opts.updateSchema ? parseBody(opts.updateSchema, req.body) : req.body);
      if (opts.prepare) data = await opts.prepare(data, ctx, existing);
      const doc = (await opts.model
        .findOneAndUpdate(filter, { ...data, updatedBy: ctx.actor.email }, { new: true, runValidators: true })
        .lean()) as OsDoc;
      await logActivity(ctx.actor, { title: `${opts.label} updated`, detail: titleOf(doc), entityType: opts.entityType, entityId: String(doc._id) });
      await opts.afterUpdate?.(doc, existing, ctx);
      return transform(doc, ctx);
    })
  );

  router.delete(
    '/:id',
    authorize(del),
    route(async (req) => {
      const ctx = ctxOf(req);
      if (!isObjectId(req.params.id)) throw new NotFoundError(opts.label);
      const filter = { ...(await baseFilter(ctx)), _id: oid(req.params.id as string) };
      const doc = (opts.hardDelete || !hasRecordStatus
        ? await opts.model.findOneAndDelete(filter).lean()
        : await opts.model.findOneAndUpdate(filter, { recordStatus: 'archived', updatedBy: ctx.actor.email }, { new: true }).lean()) as OsDoc | null;
      if (!doc) throw new NotFoundError(opts.label);
      await logActivity(ctx.actor, { title: `${opts.label} deleted`, detail: titleOf(doc), entityType: opts.entityType, entityId: String(doc._id) });
      return { id: String(doc._id) };
    })
  );

  return router;
}
