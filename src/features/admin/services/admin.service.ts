import {
  Organization, User, AuditLog, LeadCategory, UserSession,
  getPlatformSettings, RegistrationInvite, AccessRequest,
} from '../../../models/index.js';
import type { IOrganization } from '../../../models/Organization.js';
import { hashPassword } from '../../../shared/utils/jwt.js';
import { ConflictError, NotFoundError, ForbiddenError } from '../../../shared/errors/index.js';
import { ROLE_PERMISSIONS } from '../../../shared/types/index.js';
import type { UserRole } from '../../../shared/types/index.js';
import { PLATFORM_ORG_SLUG } from '../../../shared/constants/platform.js';
import { getMaxUsersForPlan, PLAN_CONFIG, type SubscriptionPlan } from '../../../shared/constants/plans.js';
import { activityService } from '../../activity/services/activity.service.js';
import crypto from 'crypto';

interface AdminOrgAdminUser {
  email: string;
  firstName: string;
  lastName: string;
  lastLoginAt?: Date;
}

export interface AdminOrganizationListItem {
  _id: unknown;
  name: string;
  slug: string;
  logo?: string;
  website?: string;
  industry?: string;
  subscriptionPlan: SubscriptionPlan;
  maxUsers: number;
  planStartedAt?: Date;
  planExpiresAt?: Date;
  settings: IOrganization['settings'];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userCount: number;
  adminUser: AdminOrgAdminUser | null;
  totalTimeSeconds: number;
}

interface AdminPlatformStats {
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  activeUsers: number;
  platformAdmins: number;
  totalSessions: number;
  totalTimeSeconds: number;
  pendingAccessRequests: number;
  planBreakdown: Record<string, number>;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const DEFAULT_CATEGORIES = [
  { name: 'General', icon: 'users', color: '#6366f1' },
  { name: 'Hot Leads', icon: 'flame', color: '#ef4444' },
];

export class AdminService {
  async getPlatformOrg() {
    return Organization.findOne({ slug: PLATFORM_ORG_SLUG });
  }

  async getStats(): Promise<AdminPlatformStats> {
    const platformOrg = await this.getPlatformOrg();
    const tenantFilter = platformOrg
      ? { _id: { $ne: platformOrg._id } }
      : {};

    const [totalOrganizations, activeOrganizations, totalUsers, activeUsers, totalSessions, timeAgg, pendingAccessRequests] = await Promise.all([
      Organization.countDocuments(tenantFilter),
      Organization.countDocuments({ ...tenantFilter, isActive: true }),
      User.countDocuments(platformOrg ? { organizationId: { $ne: platformOrg._id } } : {}),
      User.countDocuments(platformOrg ? { organizationId: { $ne: platformOrg._id }, isActive: true } : { isActive: true }),
      UserSession.countDocuments({}),
      UserSession.aggregate([
        { $group: { _id: null, totalSeconds: { $sum: '$durationSeconds' } } },
      ]),
      AccessRequest.countDocuments({ status: 'pending' }),
    ]);

    const platformAdmins = platformOrg
      ? await User.countDocuments({ organizationId: platformOrg._id, role: 'super_admin', isActive: true })
      : 0;

    const planBreakdown = await Organization.aggregate([
      { $match: tenantFilter },
      { $group: { _id: '$subscriptionPlan', count: { $sum: 1 } } },
    ]);

    return {
      totalOrganizations,
      activeOrganizations,
      totalUsers,
      activeUsers,
      platformAdmins,
      totalSessions,
      totalTimeSeconds: timeAgg[0]?.totalSeconds || 0,
      pendingAccessRequests,
      planBreakdown: planBreakdown.reduce((acc, p) => {
        acc[p._id || 'starter'] = p.count;
        return acc;
      }, {} as Record<string, number>),
    };
  }

  async listOrganizations(): Promise<AdminOrganizationListItem[]> {
    const platformOrg = await this.getPlatformOrg();
    const filter = platformOrg ? { _id: { $ne: platformOrg._id } } : {};

    const orgs = await Organization.find(filter).sort({ createdAt: -1 }).lean();
    return Promise.all(
      orgs.map(async (org): Promise<AdminOrganizationListItem> => {
        const [userCount, adminUser, totalTime] = await Promise.all([
          User.countDocuments({ organizationId: org._id, isActive: true }),
          User.findOne({ organizationId: org._id, role: 'admin' }).select('email firstName lastName lastLoginAt').lean(),
          UserSession.aggregate([
            { $match: { organizationId: org._id } },
            { $group: { _id: null, totalSeconds: { $sum: '$durationSeconds' } } },
          ]),
        ]);
        return {
          _id: org._id,
          name: org.name,
          slug: org.slug,
          logo: org.logo,
          website: org.website,
          industry: org.industry,
          subscriptionPlan: org.subscriptionPlan,
          maxUsers: org.maxUsers,
          planStartedAt: org.planStartedAt,
          planExpiresAt: org.planExpiresAt,
          settings: org.settings,
          isActive: org.isActive,
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
          userCount,
          adminUser: adminUser
            ? {
                email: adminUser.email,
                firstName: adminUser.firstName,
                lastName: adminUser.lastName,
                lastLoginAt: adminUser.lastLoginAt,
              }
            : null,
          totalTimeSeconds: totalTime[0]?.totalSeconds || 0,
        };
      })
    );
  }

  async createOrganization(
    adminUserId: string,
    platformOrgId: string,
    data: {
      name: string;
      industry?: string;
      website?: string;
      logo?: string;
      adminEmail: string;
      adminPassword: string;
      adminFirstName: string;
      adminLastName: string;
      plan?: SubscriptionPlan;
    }
  ) {
    const existingUser = await User.findOne({ email: data.adminEmail.toLowerCase() });
    if (existingUser) throw new ConflictError('Admin email already registered');

    const plan = data.plan || 'starter';
    const maxUsers = getMaxUsersForPlan(plan);
    let slug = slugify(data.name);
    const slugExists = await Organization.findOne({ slug });
    if (slugExists) slug = `${slug}-${Date.now()}`;

    const planExpiresAt = new Date();
    planExpiresAt.setFullYear(planExpiresAt.getFullYear() + 1);

    const organization = await Organization.create({
      name: data.name,
      slug,
      industry: data.industry,
      website: data.website,
      logo: data.logo || undefined,
      subscriptionPlan: plan,
      maxUsers,
      planStartedAt: new Date(),
      planExpiresAt,
    });

    const adminUser = await User.create({
      organizationId: organization._id,
      email: data.adminEmail.toLowerCase(),
      password: await hashPassword(data.adminPassword),
      firstName: data.adminFirstName,
      lastName: data.adminLastName,
      role: 'admin' as UserRole,
      permissions: ROLE_PERMISSIONS.admin,
    });

    for (const cat of DEFAULT_CATEGORIES) {
      await LeadCategory.create({
        organizationId: organization._id,
        name: cat.name,
        slug: cat.name.toLowerCase().replace(/\s+/g, '-'),
        icon: cat.icon,
        color: cat.color,
        assignedTeam: [adminUser._id],
      });
    }

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'create',
      entityType: 'organization',
      entityId: organization._id.toString(),
      metadata: { name: data.name, adminEmail: data.adminEmail },
    });

    return {
      organization,
      adminUser: {
        _id: adminUser._id,
        email: adminUser.email,
        firstName: adminUser.firstName,
        lastName: adminUser.lastName,
        role: adminUser.role,
      },
    };
  }

  async updateOrganization(platformOrgId: string, adminUserId: string, id: string, data: {
    isActive?: boolean;
    name?: string;
    subscriptionPlan?: SubscriptionPlan;
    maxUsers?: number;
    planExpiresAt?: string;
  }) {
    const updates: Record<string, unknown> = { ...data };
    if (data.subscriptionPlan) {
      updates.maxUsers = data.maxUsers ?? getMaxUsersForPlan(data.subscriptionPlan);
    }
    if (data.planExpiresAt) {
      updates.planExpiresAt = new Date(data.planExpiresAt);
    }

    const org = await Organization.findByIdAndUpdate(id, updates, { new: true });
    if (!org) throw new NotFoundError('Organization');

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'update',
      entityType: 'organization',
      entityId: id,
      metadata: data,
    });

    return org;
  }

  async listPlatformAdmins() {
    const platformOrg = await this.getPlatformOrg();
    if (!platformOrg) return [];

    return User.find({ organizationId: platformOrg._id, role: 'super_admin' })
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();
  }

  async createPlatformAdmin(
    adminUserId: string,
    platformOrgId: string,
    data: { email: string; password: string; firstName: string; lastName: string }
  ) {
    const existing = await User.findOne({ email: data.email.toLowerCase() });
    if (existing) throw new ConflictError('Email already registered');

    const user = await User.create({
      organizationId: platformOrgId,
      email: data.email.toLowerCase(),
      password: await hashPassword(data.password),
      firstName: data.firstName,
      lastName: data.lastName,
      role: 'super_admin' as UserRole,
      permissions: ROLE_PERMISSIONS.super_admin,
    });

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'create',
      entityType: 'platform_admin',
      entityId: user._id.toString(),
      metadata: { email: data.email },
    });

    return {
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async getActivity(query: { organizationId?: string; days?: number }) {
    const days = query.days || 30;
    const [summary, recentSessions, auditLogs] = await Promise.all([
      activityService.getUserActivitySummary(query.organizationId, days),
      activityService.getRecentSessions(query.organizationId, 30),
      AuditLog.find(query.organizationId ? { organizationId: query.organizationId } : {})
        .populate('userId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ]);

    return { summary, recentSessions, auditLogs };
  }

  async getAuditLogs(platformOrgId: string) {
    return AuditLog.find({ organizationId: platformOrgId })
      .populate('userId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
  }

  async getSettings() {
    const settings = await getPlatformSettings();
    return {
      allowPublicRegistration: settings.allowPublicRegistration,
      inviteOnlyMode: settings.inviteOnlyMode,
      plans: PLAN_CONFIG,
    };
  }

  async updateSettings(adminUserId: string, platformOrgId: string, data: {
    allowPublicRegistration?: boolean;
    inviteOnlyMode?: boolean;
  }) {
    const settings = await getPlatformSettings();
    if (data.allowPublicRegistration !== undefined) settings.allowPublicRegistration = data.allowPublicRegistration;
    if (data.inviteOnlyMode !== undefined) settings.inviteOnlyMode = data.inviteOnlyMode;
    await settings.save();

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'update',
      entityType: 'platform_settings',
      metadata: data,
    });

    return settings;
  }

  async listInvites() {
    return RegistrationInvite.find({ usedAt: { $exists: false } })
      .populate('createdBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .lean();
  }

  async createInvite(adminUserId: string, platformOrgId: string, data: {
    email?: string;
    organizationName?: string;
    plan?: SubscriptionPlan;
    expiresInDays?: number;
  }) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays || 7));

    const invite = await RegistrationInvite.create({
      token,
      email: data.email?.toLowerCase(),
      organizationName: data.organizationName,
      plan: data.plan || 'starter',
      createdBy: adminUserId,
      expiresAt,
    });

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'create',
      entityType: 'registration_invite',
      entityId: invite._id.toString(),
      metadata: { email: data.email, plan: data.plan },
    });

    return invite;
  }

  async listAccessRequests(status?: string) {
    const filter = status && status !== 'all' ? { status } : {};
    return AccessRequest.find(filter)
      .populate('reviewedBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .lean();
  }

  async updateAccessRequest(
    adminUserId: string,
    platformOrgId: string,
    id: string,
    data: { status?: string; adminNotes?: string }
  ) {
    const request = await AccessRequest.findById(id);
    if (!request) throw new NotFoundError('Access request');

    if (data.status) request.status = data.status as typeof request.status;
    if (data.adminNotes !== undefined) request.adminNotes = data.adminNotes;
    request.reviewedBy = adminUserId as unknown as typeof request.reviewedBy;
    request.reviewedAt = new Date();
    await request.save();

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'update',
      entityType: 'access_request',
      entityId: id,
      metadata: { status: data.status, email: request.email },
    });

    return AccessRequest.findById(id)
      .populate('reviewedBy', 'firstName lastName email')
      .lean();
  }

  async deleteAccessRequest(adminUserId: string, platformOrgId: string, id: string) {
    const request = await AccessRequest.findByIdAndDelete(id);
    if (!request) throw new NotFoundError('Access request');

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'delete',
      entityType: 'access_request',
      entityId: id,
      metadata: { email: request.email },
    });

    return request;
  }

  async revokeInvite(adminUserId: string, platformOrgId: string, id: string) {
    const invite = await RegistrationInvite.findByIdAndDelete(id);
    if (!invite) throw new NotFoundError('Invite');

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'delete',
      entityType: 'registration_invite',
      entityId: id,
    });

    return invite;
  }

  async getOrganizationById(id: string) {
    const platformOrg = await this.getPlatformOrg();
    if (platformOrg && platformOrg._id.toString() === id) {
      throw new ForbiddenError('Cannot manage platform organization as a tenant');
    }
    const org = await Organization.findById(id).lean();
    if (!org) throw new NotFoundError('Organization');
    return org;
  }

  async listOrganizationUsers(organizationId: string) {
    await this.getOrganizationById(organizationId);
    return User.find({ organizationId, isActive: true })
      .select('-password')
      .sort({ role: 1, createdAt: -1 })
      .lean();
  }

  async createOrganizationUser(
    adminUserId: string,
    platformOrgId: string,
    organizationId: string,
    data: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      role?: UserRole;
      department?: string;
    }
  ) {
    const org = await Organization.findById(organizationId);
    if (!org) throw new NotFoundError('Organization');

    const userCount = await User.countDocuments({ organizationId, isActive: true });
    if (userCount >= org.maxUsers) {
      throw new ForbiddenError(`User limit reached (${org.maxUsers}). Upgrade the company plan.`);
    }

    const existing = await User.findOne({ email: data.email.toLowerCase() });
    if (existing) throw new ConflictError('Email already registered');

    const role = (data.role || 'admin') as UserRole;
    if (role === 'super_admin') {
      throw new ForbiddenError('Cannot assign super_admin to a company user');
    }

    const user = await User.create({
      organizationId,
      email: data.email.toLowerCase(),
      password: await hashPassword(data.password),
      firstName: data.firstName,
      lastName: data.lastName,
      role,
      department: data.department,
      permissions: ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.sales,
    });

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'create',
      entityType: 'company_user',
      entityId: user._id.toString(),
      metadata: { organizationId, email: data.email, role },
    });

    return {
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      department: user.department,
      createdAt: user.createdAt,
    };
  }

  async updateOrganizationUser(
    adminUserId: string,
    platformOrgId: string,
    organizationId: string,
    userId: string,
    data: { password?: string; role?: UserRole; firstName?: string; lastName?: string; isActive?: boolean }
  ) {
    await this.getOrganizationById(organizationId);

    const updates: Record<string, unknown> = { ...data };
    if (data.password) {
      updates.password = await hashPassword(data.password);
    }
    if (data.role === 'super_admin') {
      throw new ForbiddenError('Cannot assign super_admin to a company user');
    }
    if (data.role) {
      updates.permissions = ROLE_PERMISSIONS[data.role];
    }

    const user = await User.findOneAndUpdate(
      { _id: userId, organizationId },
      updates,
      { new: true }
    ).select('-password');

    if (!user) throw new NotFoundError('User');

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'update',
      entityType: 'company_user',
      entityId: userId,
      metadata: { organizationId, ...data, password: data.password ? '[reset]' : undefined },
    });

    return user;
  }

  async deactivateOrganizationUser(
    adminUserId: string,
    platformOrgId: string,
    organizationId: string,
    userId: string
  ) {
    await this.getOrganizationById(organizationId);
    const user = await User.findOneAndUpdate(
      { _id: userId, organizationId },
      { isActive: false },
      { new: true }
    ).select('-password');
    if (!user) throw new NotFoundError('User');

    await AuditLog.create({
      organizationId: platformOrgId,
      userId: adminUserId,
      action: 'delete',
      entityType: 'company_user',
      entityId: userId,
      metadata: { organizationId },
    });

    return user;
  }
}

export const adminService = new AdminService();
