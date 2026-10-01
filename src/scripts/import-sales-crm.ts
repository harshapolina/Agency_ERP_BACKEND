/**
 * One-off import of the legacy Sales CRM database into an organization.
 *
 *   SOURCE_MONGODB_URI=mongodb+srv://.../sales_crm_dev npx tsx src/scripts/import-sales-crm.ts --org editco-media [--dry-run]
 *   ... --rollback   removes everything this script inserted for the org
 *
 * Source `_id`s are preserved so cross-references survive, and every document is upserted by `_id`
 * (safe to re-run). Inserted documents carry `migrationSource` so they can be rolled back.
 */
import mongoose, { Types, type Connection } from 'mongoose';
import bcrypt from 'bcryptjs';
import { randomBytes, createDecipheriv, createHash } from 'crypto';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { connectionForOrganization } from '../config/tenant.js';
import { encryptSecret, decryptSecret } from '../shared/utils/crypto.js';
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TAG = 'sales_crm_dev';
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = flag('dry-run');
const ROLLBACK = flag('rollback');
const ORG_SLUG = opt('org');
const SOURCE_URI = process.env.SOURCE_MONGODB_URI;
const LEGACY_SECRET = process.env.LEGACY_SESSION_SECRET;

if (!ORG_SLUG) throw new Error('--org <slug> is required');
if (!SOURCE_URI && !ROLLBACK) throw new Error('SOURCE_MONGODB_URI is required');

const summary: Array<[string, string, number, number]> = [];

async function main() {
  await connectDatabase();
  const core = mongoose.connection.db!;
  const org = await core.collection('organizations').findOne({ slug: ORG_SLUG });
  if (!org) throw new Error(`Organization "${ORG_SLUG}" not found`);
  const orgId = org._id as Types.ObjectId;
  const tenant: Connection = await connectionForOrganization(String(orgId));
  const tdb = tenant.db!;
  console.log(`Target: ${org.name} (${orgId}) → database "${tdb.databaseName}"${DRY ? ' [DRY RUN]' : ''}`);

  if (ROLLBACK) {
    const cols = await tdb.listCollections().toArray();
    for (const c of cols) {
      const r = await tdb.collection(c.name).deleteMany({ organizationId: orgId, migrationSource: TAG });
      if (r.deletedCount) console.log(`  ${c.name}: removed ${r.deletedCount}`);
    }
    const u = await core.collection('users').deleteMany({ organizationId: orgId, migrationSource: TAG });
    console.log(`  users: removed ${u.deletedCount}`);
    return;
  }

  const src = await mongoose.createConnection(SOURCE_URI!).asPromise();
  const sdb = src.db!;
  const all = async (name: string) => sdb.collection(name).find().toArray() as Promise<Doc[]>;

  // ---------------------------------------------------------------- users
  const admin = await core.collection('users').findOne({ organizationId: orgId, role: 'admin', isActive: true });
  if (!admin) throw new Error('Organization has no active admin user');
  const staff = await all('staffusers');
  const userIdMap = new Map<string, Types.ObjectId>();
  const userByEmail = new Map<string, Types.ObjectId>();
  const existingUsers = await core.collection('users').find({ organizationId: orgId }).toArray();
  for (const u of existingUsers) userByEmail.set(u.email, u._id as Types.ObjectId);
  const platformAdmins = new Set(
    (await core.collection('users').find({ role: 'super_admin' }).toArray()).map((u) => String(u.email).toLowerCase())
  );

  const userDocs: Doc[] = [];
  for (const s of staff) {
    const email = String(s.email).toLowerCase();
    const existing = userByEmail.get(email);
    if (existing) { userIdMap.set(String(s._id), existing); continue; }
    if (platformAdmins.has(email)) {
      userIdMap.set(String(s._id), admin._id as Types.ObjectId);
      userByEmail.set(email, admin._id as Types.ObjectId);
      continue;
    }
    const [firstName, ...rest] = String(s.name || email.split('@')[0]).trim().split(/\s+/);
    userDocs.push({
      _id: s._id,
      organizationId: orgId,
      email,
      password: await bcrypt.hash(randomBytes(24).toString('hex'), 12),
      firstName,
      lastName: rest.join(' ') || '-',
      role: s.role === 'sales' ? 'sales' : 'admin',
      permissions: [],
      isActive: Boolean(s.isActive),
      lastLoginAt: s.lastLoginAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    userIdMap.set(String(s._id), s._id);
    userByEmail.set(email, s._id);
  }
  await upsert(core, 'staffusers', 'users', userDocs);

  const uid = (id: unknown) => (id ? userIdMap.get(String(id)) : undefined);
  const uidByEmail = (email: unknown) =>
    (email && userByEmail.get(String(email).toLowerCase())) || (admin._id as Types.ObjectId);

  const base = (d: Doc): Doc => {
    const { __v, ...rest } = d; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...rest, organizationId: orgId, recordStatus: d.recordStatus || 'active', createdBy: d.createdBy ?? '', updatedBy: d.updatedBy ?? '' };
  };
  const copy = async (from: string, to: string, map: (d: Doc) => Doc | null = base) =>
    upsert(tdb, from, to, (await all(from)).map(map).filter(Boolean) as Doc[]);

  // ---------------------------------------------------------------- CRM
  await copy('oscompanies', 'companies', (d) => ({
    ...base(d), country: 'India', tags: [], createdBy: uidByEmail(d.createdBy), legacyCreatedBy: d.createdBy,
  }));
  await copy('oscontacts', 'contacts', (d) => {
    const [firstName, ...rest] = String(d.name || 'Unknown').trim().split(/\s+/);
    const { name, jobTitle, ...r } = base(d); // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...r, firstName, lastName: rest.join(' '), title: jobTitle, createdBy: uidByEmail(d.createdBy), legacyCreatedBy: d.createdBy };
  });
  await copy('conversions', 'conversions');
  await copy('osvendors', 'vendors');

  const categories = await tdb.collection('leadcategories').find({ organizationId: orgId }).toArray();
  const template = categories[0];
  const categoryFor = async (slug: string, name: string) => {
    const hit = categories.find((c) => c.slug === slug || c.name?.toLowerCase() === name.toLowerCase());
    if (hit) return hit._id;
    const doc = {
      _id: new Types.ObjectId(), organizationId: orgId, name, slug, icon: 'folder', color: '#64748b',
      pipelineStages: template?.pipelineStages ?? ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
      assignedTeam: [], isActive: true, leadCount: 0, customFields: [], migrationSource: TAG,
      createdAt: new Date(), updatedAt: new Date(),
    };
    if (!DRY) await tdb.collection('leadcategories').updateOne({ organizationId: orgId, slug }, { $setOnInsert: doc }, { upsert: true });
    const saved = DRY ? doc : await tdb.collection('leadcategories').findOne({ organizationId: orgId, slug });
    categories.push(saved!);
    return saved!._id;
  };
  const leads: Doc[] = [];
  for (const d of await all('osleads')) {
    const { name, assignedOwner, industrySlug, recordStatus, updatedBy, __v, ...r } = d; // eslint-disable-line @typescript-eslint/no-unused-vars
    leads.push({
      ...r,
      organizationId: orgId,
      categoryId: await categoryFor(industrySlug || 'general', d.industry || 'General'),
      firstName: name || d.company || 'Unknown',
      tags: [], score: 0, currency: 'INR', country: 'India', inCallingQueue: false,
      isArchived: recordStatus !== 'active',
      customFields: assignedOwner ? { assignedOwner } : {},
      createdBy: uidByEmail(d.createdBy),
    });
  }
  await upsert(tdb, 'osleads', 'leads', leads);
  await copy('osleadactivities', 'leadactivities', (d) => ({
    _id: d._id, organizationId: orgId, leadId: d.leadId, type: d.toStatus ? 'status_change' : 'note',
    title: d.reason || d.eventType || 'Activity', description: d.note || '',
    metadata: { eventType: d.eventType, fromStatus: d.fromStatus, toStatus: d.toStatus, expectedValue: d.expectedValue },
    createdBy: uidByEmail(d.createdBy), createdAt: d.createdAt,
  }));

  // ---------------------------------------------------------------- delivery
  await copy('osprojects', 'projects', (d) => ({
    ...base(d), assignedTeam: [], primaryPocUserId: uid(d.primaryPocUserId),
    createdBy: uidByEmail(d.createdBy), legacyCreatedBy: d.createdBy,
  }));
  await copy('osprojectmembers', 'projectmembers', (d) => ({ ...base(d), userId: uid(d.userId) ?? admin._id }));
  await copy('osmilestones', 'milestones');
  await copy('ostasks', 'tasks', (d) => {
    const { assignedToId, createdById, ...r } = base(d);
    return { ...r, assignedTo: uid(assignedToId), createdBy: uid(createdById) ?? uidByEmail(d.createdBy), legacyCreatedBy: d.createdBy };
  });
  await copy('editcotrackerrows', 'trackerrows');
  await copy('editcotrackercheckins', 'trackercheckins', (d) => ({ ...base(d), userId: userByEmail.get(d.email) }));
  await copy('activityevents', 'activityevents', (d) => ({ ...base(d), actorUserId: uid(d.actorUserId) }));
  await copy('osreminderlogs', 'reminderlogs');
  await copy('portalaccesses', 'portalaccesses', (d) => {
    const { token, ...r } = base(d); // eslint-disable-line @typescript-eslint/no-unused-vars
    return r;
  });

  // ---------------------------------------------------------------- finance
  await copy('osmanualrevenues', 'manualrevenues');
  await copy('ostransactions', 'transactions');
  await copy('osrecurringpayments', 'recurringpayments');
  let reencrypted = 0;
  let unreadable = 0;
  await copy('osproductcredentials', 'productcredentials', (d) => {
    const r = base(d);
    const plain = decryptLegacy(d);
    if (plain) {
      const enc = encryptSecret(plain)!;
      Object.assign(r, { passwordCipher: enc.cipher, passwordIv: enc.iv, passwordTag: enc.tag });
      reencrypted++;
    } else if (d.passwordCipher) {
      Object.assign(r, { passwordCipher: '', passwordIv: '', passwordTag: '', legacyPasswordUnreadable: true });
      unreadable++;
    }
    return r;
  });
  console.log(`  credentials: ${reencrypted} re-encrypted, ${unreadable} need the password re-entered`);

  // ---------------------------------------------------------------- growth
  await copy('referrers', 'referrers');
  await copy('referrals', 'referrals');
  await copy('referralactivities', 'referralactivities');
  await copy('jobs', 'jobs');
  await copy('jobapplications', 'jobapplications');
  await copy('egaapplications', 'egaapplications');
  await copy('newslettersubscribers', 'newslettersubscribers', (d) => ({ ...base(d), status: 'subscribed' }));
  await copy('servicecatalogs', 'servicecatalogs');
  await copy('industrycatalogs', 'industrycatalogs');

  // ---------------------------------------------------------------- sales team
  const overrides = new Map((await all('salespermissionoverrides')).map((o) => [String(o.salesEmployeeId), o.overrides]));
  const takenUsers = new Set(
    (await tdb.collection('salesemployees').find({ organizationId: orgId }).toArray())
      .filter((e) => e.migrationSource !== TAG)
      .map((e) => String(e.userId))
  );
  await copy('salesemployees', 'salesemployees', (d) => {
    const userId = uid(d.staffUserId);
    if (!userId || takenUsers.has(String(userId))) return null;
    const { staffUserId, ...r } = base(d); // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...r, userId, moduleOverrides: overrides.get(String(d._id)) ?? {} };
  });
  await copy('salestasks', 'salestasks');
  await copy('salesattendances', 'salesattendances');
  await copy('salesactivityevents', 'salesactivityevents');
  await copy('salesauditlogs', 'fieldauditlogs', (d) => ({
    _id: d._id, organizationId: orgId, recordStatus: 'active', entityType: d.entityType, entityId: String(d.entityId),
    field: d.field || d.action, oldValue: d.oldValue ?? '', newValue: d.newValue ?? '', reason: d.reason ?? '',
    createdBy: d.actorEmail ?? '', updatedBy: '', createdAt: d.createdAt,
  }));
  if (!DRY) {
    for (const prefix of ['SA', 'SE']) {
      const codes = (await all('salesemployees')).map((e) => String(e.employeeCode)).filter((c) => c.startsWith(`${prefix}-`));
      const max = Math.max(0, ...codes.map((c) => Number(c.slice(3))).filter(Number.isFinite));
      await tdb.collection('counters').updateOne(
        { organizationId: orgId, key: `sales:${prefix}` },
        [{ $set: { seq: { $max: [{ $ifNull: ['$seq', 0] }, max] }, recordStatus: 'active' } }],
        { upsert: true }
      );
    }
  }

  // ---------------------------------------------------------------- notifications
  const employeeUser = new Map((await all('salesemployees')).map((e) => [String(e._id), uid(e.staffUserId)]));
  const NOTIF_TYPE: Record<string, string> = {
    task: 'task_assigned', lead: 'lead_assigned', recurring_payment: 'finance_updated', task_assigned: 'task_assigned',
  };
  await copy('osnotifications', 'notifications', (d) => ({
    _id: d._id, organizationId: orgId, userId: uidByEmail(d.recipientEmail),
    type: NOTIF_TYPE[d.type] ?? 'system_alert', title: d.title || 'Notification', message: d.body || d.title || '',
    read: true, metadata: { href: d.href, legacyType: d.type, conversionUuid: d.conversionUuid }, createdAt: d.createdAt,
  }));
  await copy('salesnotifications', 'notifications', (d) => ({
    _id: d._id, organizationId: orgId, userId: employeeUser.get(String(d.recipientEmployeeId)) ?? admin._id,
    type: NOTIF_TYPE[d.type] ?? 'system_alert', title: d.title || 'Notification', message: d.body || d.title || '',
    read: true, metadata: { href: d.href, legacyType: d.type }, createdAt: d.createdAt,
  }));

  // ---------------------------------------------------------------- no model in this app; preserved as-is
  for (const name of ['siteworks', 'sitecrewmembers', 'siteclientlogos', 'referralclicks', 'egaformconfigs', 'adminusers']) {
    await copy(name, `legacy_${name}`, (d) => ({ ...d, organizationId: orgId }));
  }

  await src.close();
}

function decryptLegacy(d: Doc): string | null {
  if (!d.passwordCipher || !d.passwordIv || !d.passwordTag) return null;
  const current = decryptSecret({ cipher: d.passwordCipher, iv: d.passwordIv, tag: d.passwordTag });
  if (current) return current;
  if (!LEGACY_SECRET) return null;
  try {
    const key = createHash('sha256').update(LEGACY_SECRET).digest();
    const dec = createDecipheriv('aes-256-gcm', key, Buffer.from(d.passwordIv, 'base64'));
    dec.setAuthTag(Buffer.from(d.passwordTag, 'base64'));
    return Buffer.concat([dec.update(Buffer.from(d.passwordCipher, 'base64')), dec.final()]).toString('utf8');
  } catch {
    return null;
  }
}

async function upsert(db: NonNullable<Connection['db']>, from: string, to: string, docs: Doc[]) {
  let existing = 0;
  if (docs.length) existing = await db.collection(to).countDocuments({ _id: { $in: docs.map((d) => d._id) } });
  summary.push([from, to, docs.length, docs.length - existing]);
  if (DRY || !docs.length) return;
  await db.collection(to).bulkWrite(
    docs.map((d) => ({
      updateOne: { filter: { _id: d._id }, update: { $setOnInsert: { ...d, migrationSource: TAG } }, upsert: true },
    })),
    { ordered: false }
  );
}

main()
  .then(() => {
    if (summary.length) {
      console.log('\n  source → target                                   found   new');
      for (const [f, t, n, added] of summary) console.log(`  ${`${f} → ${t}`.padEnd(48)} ${String(n).padStart(5)} ${String(added).padStart(5)}`);
    }
  })
  .catch((err) => {
    console.error('Import failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
