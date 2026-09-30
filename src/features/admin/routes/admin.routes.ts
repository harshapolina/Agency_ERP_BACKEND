import { Router } from 'express';
import { COMPANY_ROLES, type UserRole } from '../../../shared/types/index.js';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller.js';
import { authenticate, authorizeRoles } from '../../../shared/middleware/auth.js';
import { validateBody } from '../../../shared/middleware/validate.js';
import { organizationDatabaseRoutes } from './database.routes.js';
import { organizationSettingsRoutes } from '../../os/routes/settings.routes.js';
import { logoSchema } from '../../../shared/os/company.js';

const router = Router();

router.use(authenticate);
router.use(authorizeRoles('super_admin'));

const planEnum = z.enum(['starter', 'professional', 'enterprise']);

const createOrgSchema = z.object({
  name: z.string().min(1).max(200),
  industry: z.string().optional(),
  website: z.string().optional(),
  plan: planEnum.optional(),
  logo: logoSchema.optional(),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminFirstName: z.string().min(1),
  adminLastName: z.string().min(1),
});

const updateOrgSchema = z.object({
  isActive: z.boolean().optional(),
  name: z.string().min(1).optional(),
  subscriptionPlan: planEnum.optional(),
  maxUsers: z.number().min(1).optional(),
  planExpiresAt: z.string().datetime().optional(),
});

const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

const settingsSchema = z.object({
  allowPublicRegistration: z.boolean().optional(),
  inviteOnlyMode: z.boolean().optional(),
});

const createInviteSchema = z.object({
  email: z.string().email().optional(),
  organizationName: z.string().optional(),
  plan: planEnum.optional(),
  expiresInDays: z.number().min(1).max(90).optional(),
});

const createCompanyUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(COMPANY_ROLES as [UserRole, ...UserRole[]]).optional(),
  department: z.string().optional(),
});

const updateCompanyUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(COMPANY_ROLES as [UserRole, ...UserRole[]]).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

const updateAccessRequestSchema = z.object({
  status: z.enum(['pending', 'contacted', 'approved', 'rejected']).optional(),
  adminNotes: z.string().max(2000).optional(),
});

router.get('/stats', adminController.getStats.bind(adminController));
router.get('/organizations', adminController.listOrganizations.bind(adminController));
router.get('/organizations/:id', adminController.getOrganization.bind(adminController));
router.post('/organizations', validateBody(createOrgSchema), adminController.createOrganization.bind(adminController));
router.patch('/organizations/:id', validateBody(updateOrgSchema), adminController.updateOrganization.bind(adminController));
router.use('/organizations/:id/database', organizationDatabaseRoutes);
router.use('/organizations/:id/settings', organizationSettingsRoutes);
router.get('/organizations/:id/users', adminController.listOrganizationUsers.bind(adminController));
router.post('/organizations/:id/users', validateBody(createCompanyUserSchema), adminController.createOrganizationUser.bind(adminController));
router.patch('/organizations/:id/users/:userId', validateBody(updateCompanyUserSchema), adminController.updateOrganizationUser.bind(adminController));
router.delete('/organizations/:id/users/:userId', adminController.deactivateOrganizationUser.bind(adminController));
router.get('/platform-admins', adminController.listPlatformAdmins.bind(adminController));
router.post('/platform-admins', validateBody(createAdminSchema), adminController.createPlatformAdmin.bind(adminController));
router.get('/activity', adminController.getActivity.bind(adminController));
router.get('/audit-logs', adminController.getAuditLogs.bind(adminController));
router.get('/settings', adminController.getSettings.bind(adminController));
router.patch('/settings', validateBody(settingsSchema), adminController.updateSettings.bind(adminController));
router.get('/invites', adminController.listInvites.bind(adminController));
router.post('/invites', validateBody(createInviteSchema), adminController.createInvite.bind(adminController));
router.delete('/invites/:id', adminController.revokeInvite.bind(adminController));
router.get('/access-requests', adminController.listAccessRequests.bind(adminController));
router.patch('/access-requests/:id', validateBody(updateAccessRequestSchema), adminController.updateAccessRequest.bind(adminController));
router.delete('/access-requests/:id', adminController.deleteAccessRequest.bind(adminController));

export default router;
