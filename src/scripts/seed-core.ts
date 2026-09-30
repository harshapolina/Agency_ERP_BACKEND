import { Organization, User, LeadCategory, Lead, Task, Project, Invoice, CallLog, FollowUp, Proposal } from '../models/index.js';
import { AutomationRule } from '../models/AutomationRule.js';
import { hashPassword } from '../shared/utils/jwt.js';
import { ROLE_PERMISSIONS } from '../shared/types/index.js';
import { PLATFORM_ORG_SLUG } from '../shared/constants/platform.js';
import { logger } from '../shared/logger/index.js';
import { randomBytes, randomUUID } from 'crypto';
import { invoiceTotals } from '../shared/os/money.js';

/** Credentials come from the environment; a random password is generated (and printed once) when unset. */
function credential(emailVar: string, passwordVar: string, fallbackEmail: string) {
  const email = (process.env[emailVar] || fallbackEmail).toLowerCase();
  const provided = process.env[passwordVar];
  const password = provided || `${randomBytes(9).toString('base64url')}A1!`;
  return { email, password, generated: !provided };
}

const announce = (label: string, c: { email: string; password: string; generated: boolean }) =>
  logger.info(`${label}: ${c.email}${c.generated ? ` / ${c.password} (generated — set it via env to choose your own)` : ''}`);

const DEFAULT_CATEGORIES = [
  { name: 'Cafes', icon: 'coffee', color: '#fb923c' },
  { name: 'Restaurants', icon: 'utensils', color: '#ef4444' },
  { name: 'Hotels', icon: 'building', color: '#3b82f6' },
  { name: 'Schools', icon: 'graduation-cap', color: '#8b5cf6' },
  { name: 'Hospitals', icon: 'heart-pulse', color: '#ec4899' },
  { name: 'IT Companies', icon: 'laptop', color: '#10b981' },
  { name: 'Startups', icon: 'rocket', color: '#f59e0b' },
  { name: 'Realtors', icon: 'home', color: '#6366f1' },
];

/** Seeds into the already-connected database. Business records are only created when `demo` is true. */
export async function seedDatabase({ demo = process.env.SEED_DEMO === 'true', quiet = false } = {}) {
  const SUPER = credential('SEED_SUPER_ADMIN_EMAIL', 'SEED_SUPER_ADMIN_PASSWORD', 'superadmin@example.com');
  const ADMIN = credential('SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'admin@example.com');
  const SALES = credential('SEED_SALES_EMAIL', 'SEED_SALES_PASSWORD', 'sales@example.com');

  let platformOrg = await Organization.findOne({ slug: PLATFORM_ORG_SLUG });
  if (!platformOrg) {
    platformOrg = await Organization.create({
      name: 'Agency ERP Platform',
      slug: PLATFORM_ORG_SLUG,
      industry: 'SaaS Platform',
    });
    if (!quiet) logger.info('Platform organization created');
  }

  const existingSuperAdmin = await User.findOne({ role: 'super_admin' });
  if (!existingSuperAdmin) {
    await User.create({
      organizationId: platformOrg._id,
      email: SUPER.email,
      password: await hashPassword(SUPER.password),
      firstName: 'Platform',
      lastName: 'Admin',
      role: 'super_admin',
      permissions: ROLE_PERMISSIONS.super_admin,
    });
    if (!quiet) announce('Platform super admin created', SUPER);
  }

  const existing = await Organization.findOne({ slug: 'editco-media' });
  if (existing) {
    if (!quiet) logger.info('Seed data already exists, skipping...');
    return;
  }

  const org = await Organization.create({
    name: 'Editco Media',
    slug: 'editco-media',
    industry: 'Marketing & Technology',
  });

  const admin = await User.create({
    organizationId: org._id,
    email: ADMIN.email,
    password: await hashPassword(ADMIN.password),
    firstName: 'Admin',
    lastName: 'User',
    role: 'admin',
  });

  // Business data lives in the company's own database once one is connected, so a real install stops here.
  if (!demo) {
    if (!quiet) logger.info('Company created (no demo data — set SEED_DEMO=true for sample records)');
    if (!quiet) announce('Company admin', ADMIN);
    return;
  }

  const salesUser = await User.create({
    organizationId: org._id,
    email: SALES.email,
    password: await hashPassword(SALES.password),
    firstName: 'Raj',
    lastName: 'Kumar',
    role: 'sales',
  });

  const categories = [];
  for (const cat of DEFAULT_CATEGORIES) {
    const category = await LeadCategory.create({
      organizationId: org._id,
      name: cat.name,
      slug: cat.name.toLowerCase().replace(/\s+/g, '-'),
      icon: cat.icon,
      color: cat.color,
      assignedTeam: [salesUser._id],
    });
    categories.push(category);
  }

  const sampleLeads = [
    { firstName: 'Amit', lastName: 'Sharma', company: 'TechStart Pvt Ltd', email: 'amit@techstart.com', phone: '+91 98765 43210', status: 'interested', source: 'Website', score: 75 },
    { firstName: 'Priya', lastName: 'Patel', company: 'Green Cafe', email: 'priya@greencafe.com', phone: '+91 98765 43211', status: 'meeting', source: 'Referral', score: 85 },
    { firstName: 'Vikram', lastName: 'Singh', company: 'Royal Hotel', email: 'vikram@royalhotel.com', phone: '+91 98765 43212', status: 'proposal', source: 'Cold Call', score: 90 },
    { firstName: 'Sneha', lastName: 'Reddy', company: 'Bright School', email: 'sneha@brightschool.edu', phone: '+91 98765 43213', status: 'new', source: 'LinkedIn', score: 45 },
    { firstName: 'Arjun', lastName: 'Mehta', company: 'HealthFirst Clinic', email: 'arjun@healthfirst.com', phone: '+91 98765 43214', status: 'connected', source: 'Google Ads', score: 60 },
  ];

  for (let i = 0; i < sampleLeads.length; i++) {
    const cat = categories[i % categories.length];
    await Lead.create({
      organizationId: org._id,
      categoryId: cat._id,
      ...sampleLeads[i],
      assignedTo: salesUser._id,
      createdBy: admin._id,
      estimatedValue: Math.floor(Math.random() * 500000) + 50000,
    });
    await LeadCategory.findByIdAndUpdate(cat._id, { $inc: { leadCount: 1 } });
  }

  await Task.create([
    { organizationId: org._id, title: 'Follow up with TechStart', status: 'in_progress', priority: 'high', assignedTo: salesUser._id, createdBy: admin._id, dueDate: new Date(Date.now() + 86400000) },
    { organizationId: org._id, title: 'Prepare proposal for Royal Hotel', status: 'todo', priority: 'urgent', assignedTo: salesUser._id, createdBy: admin._id, dueDate: new Date(Date.now() + 172800000) },
    { organizationId: org._id, title: 'Review marketing campaign', status: 'todo', priority: 'medium', assignedTo: admin._id, createdBy: admin._id },
  ]);

  const project = await Project.create({
    organizationId: org._id,
    name: 'Green Cafe Website Redesign',
    status: 'in_progress',
    priority: 'high',
    progress: 45,
    budget: 250000,
    spent: 112500,
    assignedTeam: [salesUser._id],
    createdBy: admin._id,
    startDate: new Date(),
  });

  const lineItems = [{ description: 'Website Development', specifications: '', hsnSac: '998314', quantity: 1, uom: 'Nos', unitPrice: 150000, discountPercent: 0 }];
  const totals = invoiceTotals({ lineItems, taxRate: 0.18, overallDiscount: 0 });
  await Invoice.create({
    organizationId: org._id,
    invoiceUuid: randomUUID(),
    invoiceNumber: `EC-INV-${new Date().getFullYear()}-001`,
    projectId: project._id,
    lineItems,
    taxRate: 0.18,
    ...totals,
    amountPaid: totals.total,
    paymentDate: new Date(),
    status: 'paid',
    billToName: 'Green Cafe',
    createdBy: admin._id,
  });

  const allLeads = await Lead.find({ organizationId: org._id }).limit(3);

  if (allLeads[0]) {
    await CallLog.create([
      { organizationId: org._id, leadId: allLeads[0]._id, callerId: salesUser._id, outcome: 'connected', duration: 180, notes: 'Discussed website requirements' },
      { organizationId: org._id, leadId: allLeads[1]?._id || allLeads[0]._id, callerId: salesUser._id, outcome: 'interested', duration: 240, notes: 'Wants proposal by Friday' },
    ]);

    await FollowUp.create([
      { organizationId: org._id, leadId: allLeads[0]._id, assignedTo: salesUser._id, type: 'phone', title: 'Follow up on proposal', scheduledAt: new Date(Date.now() + 86400000), createdBy: admin._id },
      { organizationId: org._id, leadId: allLeads[1]?._id || allLeads[0]._id, assignedTo: salesUser._id, type: 'meeting', title: 'Demo meeting', scheduledAt: new Date(Date.now() + 172800000), createdBy: admin._id },
    ]);

    await Proposal.create({
      organizationId: org._id,
      leadId: allLeads[2]?._id || allLeads[0]._id,
      title: 'Royal Hotel Digital Marketing Package',
      items: [
        { description: 'Social Media Management (3 months)', quantity: 1, rate: 75000, amount: 75000 },
        { description: 'Google Ads Setup & Management', quantity: 1, rate: 50000, amount: 50000 },
      ],
      subtotal: 125000,
      taxAmount: 22500,
      total: 147500,
      status: 'sent',
      sentAt: new Date(),
      createdBy: admin._id,
    });
  }

  await AutomationRule.insertMany([
    { organizationId: org._id, name: 'New Lead Notification', trigger: 'Lead created', action: 'Notify assigned sales rep', status: 'active', createdBy: admin._id },
    { organizationId: org._id, name: 'Follow-up Reminder', trigger: 'Follow-up due in 1 hour', action: 'Send notification', status: 'active', createdBy: admin._id },
    { organizationId: org._id, name: 'Task Assignment Alert', trigger: 'Task assigned', action: 'Email assignee', status: 'active', createdBy: admin._id },
    { organizationId: org._id, name: 'Proposal Sent', trigger: 'Proposal status → sent', action: 'Log activity & notify manager', status: 'active', createdBy: admin._id },
    { organizationId: org._id, name: 'Stale Lead Alert', trigger: 'No contact in 7 days', action: 'Flag for review', status: 'draft', createdBy: admin._id },
  ]);

  if (!quiet) {
    logger.info('Seed data created successfully!');
    announce('Company admin', ADMIN);
    announce('Sales user', SALES);
  }
}
