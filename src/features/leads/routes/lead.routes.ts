import { Router } from 'express';
import { leadController } from '../controllers/lead.controller.js';
import { authenticate, authorize } from '../../../shared/middleware/auth.js';
import { validateBody, validateQuery, validateParams } from '../../../shared/middleware/validate.js';
import { createLeadSchema, updateLeadSchema, bulkUpdateLeadsSchema, leadQuerySchema, pipelineQuerySchema } from '../validators/lead.validator.js';
import { z } from 'zod';
import { route, parseBody } from '../../../shared/utils/crud.js';
import { BOARD_COLUMNS, PIPELINE_RANGES, moveLead, pipelineAnalytics, type PipelineFilters } from '../services/pipeline.service.js';

const router = Router();
const idParam = z.object({ id: z.string().min(1) });
const activitySchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'whatsapp', 'note', 'status_change', 'assignment', 'document', 'proposal', 'invoice']),
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

router.use(authenticate);

router.get('/', authorize('leads:read', 'leads:*'), validateQuery(leadQuerySchema), leadController.findAll.bind(leadController));
router.post('/', authorize('leads:*', 'leads:write'), validateBody(createLeadSchema), leadController.create.bind(leadController));
router.get('/pipeline', authorize('pipeline:*', 'leads:read', 'leads:*'), validateQuery(pipelineQuerySchema), leadController.getPipeline.bind(leadController));
router.get('/pipeline/analytics', authorize('pipeline:*', 'leads:read', 'leads:*'), route(async (req) => {
  const q = req.query as Record<string, string>;
  const range = q.range && q.range in PIPELINE_RANGES ? (q.range as PipelineFilters['range']) : 'all';
  return pipelineAnalytics(req.user!.organizationId, { range, owner: q.owner, source: q.source, categoryId: q.categoryId });
}));
const moveSchema = z.object({
  status: z.enum(BOARD_COLUMNS),
  reason: z.string().trim().min(1, 'Reason is required').max(500),
});
router.post('/:id/move', authorize('leads:*', 'leads:write'), route(async (req) => {
  const { status, reason } = parseBody<z.infer<typeof moveSchema>>(moveSchema, req.body);
  return moveLead(req.user!.organizationId, req.user!.id, req.params.id as string, status, reason);
}));
router.patch('/bulk', authorize('leads:*', 'leads:write'), validateBody(bulkUpdateLeadsSchema), leadController.bulkUpdate.bind(leadController));
router.get('/:id', authorize('leads:read', 'leads:*'), validateParams(idParam), leadController.findById.bind(leadController));
router.patch('/:id', authorize('leads:*', 'leads:write'), validateParams(idParam), validateBody(updateLeadSchema), leadController.update.bind(leadController));
router.delete('/:id', authorize('leads:*'), validateParams(idParam), leadController.delete.bind(leadController));
router.get('/:id/activities', authorize('leads:read', 'leads:*'), validateParams(idParam), leadController.getActivities.bind(leadController));
router.post('/:id/activities', authorize('leads:*', 'leads:write'), validateParams(idParam), validateBody(activitySchema), leadController.addActivity.bind(leadController));

export default router;
