import { z } from 'zod';
import { VaultProject, VaultProjectMessage, LeadProjectPitch, ProductCredential, ActivityEvent } from '../../../models/index.js';
import { authorize } from '../../../shared/middleware/auth.js';
import { crudRouter, route, parseBody, oid } from '../../../shared/utils/crud.js';
import { actorFrom, logActivity } from '../../../shared/os/activity.js';
import { encryptSecret, decryptSecret, hasEncryptedSecret } from '../../../shared/utils/crypto.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { VAULT_MESSAGE_TYPES, VAULT_PROJECT_STATUSES, PITCH_STATUSES, PITCH_WORKING_STATUSES, PITCH_FUNNEL_ORDER } from '../../../shared/constants/os.js';
import type { OsDoc } from '../../../models/os/base.js';

const isHttpUrl = (v: string) => /^https?:\/\/.+/i.test(v);
const urlOptional = z.string().optional().refine((v) => !v || isHttpUrl(v), 'URL must start with http:// or https://');

const intelligence = {
  description: z.string().optional(), category: z.string().optional(),
  targetIndustry: z.string().optional(), idealCustomer: z.string().optional(), sellingPoints: z.string().optional(),
  commonObjections: z.string().optional(), bestPitchAngle: z.string().optional(), pricingNotes: z.string().optional(),
  competitors: z.string().optional(), demoNotes: z.string().optional(), internalNotes: z.string().optional(),
};

const vaultSchema = z.object({
  name: z.string().min(2, 'Project name must be at least 2 characters'),
  localUrl: urlOptional,
  productionUrl: z.string().min(1, 'Production URL is required').refine(isHttpUrl, 'Production URL must be a valid http(s) URL'),
  loginEmail: z.string().email().optional().or(z.literal('')),
  password: z.string().optional(),
  clearPassword: z.boolean().optional(),
  status: z.enum(VAULT_PROJECT_STATUSES).optional(),
  messages: z.record(z.object({ subject: z.string().optional(), body: z.string().optional() })).optional(),
  ...intelligence,
});

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'project';

async function uniqueSlug(organizationId: string, base: string, excludeId?: string) {
  const root = slugify(base);
  for (let i = 0; ; i++) {
    const slug = i === 0 ? root : `${root}-${i}`;
    const clash = await VaultProject.findOne({ organizationId, slug, ...(excludeId && { _id: { $ne: excludeId } }) }).select('_id').lean();
    if (!clash) return slug;
  }
}

function stripSecret(doc: OsDoc) {
  const { passwordCipher, passwordIv, passwordTag, ...rest } = doc;
  return { ...rest, hasPassword: hasEncryptedSecret({ cipher: passwordCipher, iv: passwordIv, tag: passwordTag }) };
}

async function pitchStats(organizationId: string, projectIds?: unknown[]) {
  const match: Record<string, unknown> = { organizationId: oid(organizationId), recordStatus: 'active' };
  if (projectIds) match.projectId = { $in: projectIds };
  const rows = await LeadProjectPitch.aggregate([
    { $match: match },
    { $group: { _id: { projectId: '$projectId', status: '$status' }, people: { $sum: 1 }, attempts: { $sum: '$attemptCount' } } },
  ]);
  const byProject = new Map<string, Record<string, { people: number; attempts: number }>>();
  for (const r of rows) {
    const key = String(r._id.projectId);
    const entry = byProject.get(key) ?? {};
    entry[r._id.status] = { people: r.people, attempts: r.attempts };
    byProject.set(key, entry);
  }
  return byProject;
}

function summarize(stats: Record<string, { people: number; attempts: number }> = {}) {
  const count = (s: string) => stats[s]?.people ?? 0;
  const peoplePitched = Object.values(stats).reduce((s, v) => s + v.people, 0);
  const attempts = Object.values(stats).reduce((s, v) => s + v.attempts, 0);
  const interested = PITCH_WORKING_STATUSES.reduce((s, k) => s + count(k), 0) + count('won');
  const working = PITCH_WORKING_STATUSES.reduce((s, k) => s + count(k), 0);
  const won = count('won');
  const lost = count('lost');
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    peoplePitched, attempts, interested, working, won, lost,
    conversionRate: pct(won, peoplePitched),
    interestRate: pct(interested, peoplePitched),
    winRate: pct(won, won + lost),
    funnel: PITCH_FUNNEL_ORDER.map((status) => ({ status, count: count(status) })),
  };
}

async function upsertMessages(organizationId: string, projectId: unknown, messages: Record<string, { subject?: string; body?: string }>, email: string, skipEmpty: boolean) {
  for (const type of VAULT_MESSAGE_TYPES) {
    const m = messages[type] ?? {};
    const subject = type === 'email' ? (m.subject || '').trim() : '';
    const body = (m.body || '').trim();
    if (skipEmpty && !subject && !body) continue;
    await VaultProjectMessage.findOneAndUpdate(
      { organizationId, projectId, type },
      { $set: { subject, body, updatedBy: email }, $setOnInsert: { organizationId, projectId, type, createdBy: email } },
      { upsert: true }
    );
  }
}

export const vaultRoutes = crudRouter({
  model: VaultProject,
  resource: 'vault',
  entityType: 'vault_project',
  label: 'Vault project',
  searchFields: ['name', 'category', 'loginEmail', 'localUrl', 'productionUrl'],
  filterFields: ['status', 'category'],
  defaultSort: { name: 1 },
  createSchema: vaultSchema,
  updateSchema: vaultSchema.partial(),
  transform: (d) => stripSecret(d),
  prepare: async (data, ctx, existing) => {
    const { password, clearPassword, messages, ...rest } = data as Record<string, unknown> & { password?: string; clearPassword?: boolean };
    void messages;
    const out: Record<string, unknown> = { ...rest };
    if (!existing || (rest.name && rest.name !== existing.name)) {
      out.slug = await uniqueSlug(ctx.organizationId, String(rest.name ?? existing?.name), existing ? String(existing._id) : undefined);
    }
    if (password?.trim()) {
      const enc = encryptSecret(password)!;
      Object.assign(out, { passwordCipher: enc.cipher, passwordIv: enc.iv, passwordTag: enc.tag });
    }
    if (clearPassword) Object.assign(out, { passwordCipher: '', passwordIv: '', passwordTag: '' });
    if (rest.status === 'archived') out.recordStatus = 'active';
    return out;
  },
  afterCreate: async (doc, ctx) => {
    const messages = (ctx.req.body?.messages ?? {}) as Record<string, { subject?: string; body?: string }>;
    await upsertMessages(ctx.organizationId, doc._id, messages, ctx.actor.email, true);
  },
  extend: (router) => {
    router.get(
      '/comparison',
      authorize('vault:read'),
      route(async (req) => {
        const projects = await VaultProject.find({ organizationId: oid(req.user!.organizationId), recordStatus: 'active' }).select('name slug').sort({ name: 1 }).lean();
        const stats = await pitchStats(req.user!.organizationId, projects.map((p) => p._id));
        return projects.map((p) => {
          const s = summarize(stats.get(String(p._id)));
          return { _id: p._id, name: p.name, pitched: s.peoplePitched, interested: s.interested, working: s.working, sold: s.won, conversion: s.conversionRate };
        });
      })
    );

    router.get(
      '/:id/details',
      authorize('vault:read'),
      route(async (req) => {
        const org = req.user!.organizationId;
        const project = await VaultProject.findOne({ _id: req.params.id, organizationId: org, recordStatus: 'active' }).lean();
        if (!project) throw new NotFoundError('Vault project');
        const [messages, pitches, activity, stats] = await Promise.all([
          VaultProjectMessage.find({ organizationId: org, projectId: project._id }).lean(),
          LeadProjectPitch.find({ organizationId: org, projectId: project._id, recordStatus: 'active' })
            .populate('leadId', 'firstName lastName company status')
            .sort({ pitchedAt: -1 })
            .lean(),
          ActivityEvent.find({ organizationId: oid(org), entityType: 'vault_project', entityId: String(project._id) }).sort({ createdAt: -1 }).limit(30).lean(),
          pitchStats(org, [project._id]),
        ]);
        return { project: stripSecret(project), messages, pitches, activity, analytics: summarize(stats.get(String(project._id))) };
      })
    );

    router.put(
      '/:id/messages',
      authorize('vault:write'),
      route(async (req) => {
        const actor = actorFrom(req.user!);
        const project = await VaultProject.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' }).lean();
        if (!project) throw new NotFoundError('Vault project');
        await upsertMessages(actor.organizationId, project._id, req.body?.messages ?? {}, actor.email, false);
        await logActivity(actor, { title: 'Vault project messages updated', detail: project.name, entityType: 'vault_project', entityId: String(project._id) });
        return VaultProjectMessage.find({ organizationId: actor.organizationId, projectId: project._id }).lean();
      })
    );

    router.post(
      '/:id/reveal',
      authorize('vault:credentials'),
      route(async (req) => {
        const project = await VaultProject.findOne({ _id: req.params.id, organizationId: req.user!.organizationId, recordStatus: 'active' }).lean();
        if (!project) throw new NotFoundError('Vault project');
        if (!project.passwordCipher) throw new ValidationError('No password configured');
        const password = decryptSecret({ cipher: project.passwordCipher, iv: project.passwordIv, tag: project.passwordTag });
        if (!password) throw new ValidationError('Could not decrypt password');
        await logActivity(actorFrom(req.user!), { title: 'Vault password revealed', detail: project.name, entityType: 'vault_project', entityId: String(project._id) });
        return { password };
      })
    );

    const pitchSchema = z.object({
      leadId: z.string().min(1),
      status: z.enum(PITCH_STATUSES).optional(),
      notes: z.string().optional(),
    });

    router.post(
      '/:id/pitches',
      authorize('vault:write', 'leads:write'),
      route(async (req) => {
        const actor = actorFrom(req.user!);
        const body = parseBody<z.infer<typeof pitchSchema>>(pitchSchema, req.body);
        const project = await VaultProject.findOne({ _id: req.params.id, organizationId: actor.organizationId, recordStatus: 'active' }).lean();
        if (!project) throw new NotFoundError('Vault project');
        const existing = await LeadProjectPitch.findOne({ organizationId: actor.organizationId, leadId: body.leadId, projectId: project._id, recordStatus: 'active' });
        const pitch = existing
          ? await LeadProjectPitch.findByIdAndUpdate(
              existing._id,
              { $set: { status: body.status || existing.status, notes: body.notes ?? existing.notes, pitchedAt: new Date(), updatedBy: actor.email }, $inc: { attemptCount: 1 } },
              { new: true }
            )
          : await LeadProjectPitch.create({
              organizationId: actor.organizationId, leadId: body.leadId, projectId: project._id, projectName: project.name,
              pitchedBy: actor.name || actor.email, status: body.status || 'pitched', notes: body.notes || '',
              createdBy: actor.email, updatedBy: actor.email,
            });
        await logActivity(actor, { title: existing ? 'Pitch re-attempted' : 'Project pitched', detail: project.name, entityType: 'vault_project', entityId: String(project._id), leadId: body.leadId });
        return pitch;
      })
    );

    router.patch(
      '/pitches/:pitchId',
      authorize('vault:write', 'leads:write'),
      route(async (req) => {
        const actor = actorFrom(req.user!);
        const status = req.body?.status as string | undefined;
        if (status && !(PITCH_STATUSES as readonly string[]).includes(status)) throw new ValidationError('Invalid pitch status');
        const pitch = await LeadProjectPitch.findOneAndUpdate(
          { _id: req.params.pitchId, organizationId: actor.organizationId },
          { $set: { ...(status && { status }), ...(req.body?.notes !== undefined && { notes: req.body.notes }), updatedBy: actor.email } },
          { new: true }
        );
        if (!pitch) throw new NotFoundError('Pitch');
        return pitch;
      })
    );
  },
});

const credentialSchema = z.object({
  productName: z.string().min(1, 'Product name is required'),
  category: z.string().optional(),
  url: urlOptional,
  username: z.string().optional(),
  password: z.string().optional(),
  notes: z.string().optional(),
});

export const credentialRoutes = crudRouter({
  model: ProductCredential,
  resource: 'vault',
  entityType: 'credential',
  label: 'Credential',
  readPermission: 'vault:credentials',
  writePermission: 'vault:credentials',
  searchFields: ['productName', 'category', 'username', 'url', 'notes'],
  defaultSort: { productName: 1 },
  createSchema: credentialSchema,
  updateSchema: credentialSchema.partial(),
  titleOf: (d) => d.productName,
  transform: (d) => stripSecret(d),
  prepare: (data) => {
    const { password, ...rest } = data as Record<string, unknown> & { password?: string };
    if (password?.trim()) {
      const enc = encryptSecret(password)!;
      Object.assign(rest, { passwordCipher: enc.cipher, passwordIv: enc.iv, passwordTag: enc.tag });
    }
    return rest;
  },
  extend: (router) => {
    router.post(
      '/:id/reveal',
      authorize('vault:credentials'),
      route(async (req) => {
        const cred = await ProductCredential.findOne({ _id: req.params.id, organizationId: req.user!.organizationId, recordStatus: 'active' }).lean();
        if (!cred) throw new NotFoundError('Credential');
        const password = decryptSecret({ cipher: cred.passwordCipher, iv: cred.passwordIv, tag: cred.passwordTag });
        if (!password) throw new ValidationError('No password configured');
        await logActivity(actorFrom(req.user!), { title: 'Credential revealed', detail: cred.productName, entityType: 'credential', entityId: String(cred._id) });
        return { password };
      })
    );
  },
});
