import { Router } from 'express';
import { COMPANY_ROLES, type UserRole } from '../../../shared/types/index.js';
import { z } from 'zod';
import { userController } from '../controllers/user.controller.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../../shared/middleware/validate.js';

const router = Router();
const idParam = z.object({ id: z.string().min(1) });
const querySchema = z.object({
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  role: z.string().optional(),
});
const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  role: z.enum(COMPANY_ROLES as [UserRole, ...UserRole[]]).optional(),
  department: z.string().optional(),
});
const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  role: z.enum(COMPANY_ROLES as [UserRole, ...UserRole[]]).optional(),
  department: z.string().optional(),
});

router.use(authenticate);

router.get('/', authorize('employees:read', 'employees:*', 'users:*'), validateQuery(querySchema), userController.findAll.bind(userController));
router.post('/', authorize('employees:*', 'users:*'), validateBody(createSchema), userController.create.bind(userController));
router.patch('/:id', authorize('employees:*', 'users:*'), validateParams(idParam), validateBody(updateSchema), userController.update.bind(userController));
router.delete('/:id', authorize('employees:*', 'users:*'), validateParams(idParam), userController.deactivate.bind(userController));

export default router;
