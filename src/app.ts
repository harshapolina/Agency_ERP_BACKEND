import express from 'express';
import cors from 'cors';
import helmet from './shared/utils/helmet.js';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { env } from './config/env.js';
import { connectDatabase, getDatabaseStatus } from './config/database.js';
import { createCorsOptions } from './config/cors.js';
import { errorHandler, notFoundHandler } from './shared/middleware/errorHandler.js';

import authRoutes from './features/auth/routes/auth.routes.js';
import dashboardRoutes from './features/dashboard/routes/dashboard.routes.js';
import leadCategoryRoutes from './features/lead-categories/routes/category.routes.js';
import leadRoutes from './features/leads/routes/lead.routes.js';
import notificationRoutes from './features/notifications/routes/notification.routes.js';
import importRoutes from './features/import/routes/import.routes.js';
import callRoutes from './features/calling/routes/call.routes.js';
import followUpRoutes from './features/follow-ups/routes/followup.routes.js';
import proposalRoutes from './features/proposals/routes/proposal.routes.js';
import savedViewRoutes from './features/saved-views/routes/savedview.routes.js';
import expenseRoutes from './features/expenses/routes/expense.routes.js';
import financeRoutes from './features/finance/routes/finance.routes.js';
import userRoutes from './features/users/routes/user.routes.js';
import automationRoutes from './features/automation/routes/automation.routes.js';
import adminRoutes from './features/admin/routes/admin.routes.js';
import activityRoutes from './features/activity/routes/activity.routes.js';
import accessRequestRoutes from './features/access-requests/routes/access-request.routes.js';
import { projectRoutes, taskRoutes, meetingRoutes, documentRoutes } from './features/os/routes/delivery.routes.js';
import { invoiceRoutes, paymentRoutes, recurringPaymentRoutes, transactionRoutes, revenueRoutes } from './features/os/routes/finance.routes.js';
import { conversionRoutes, vendorRoutes } from './features/os/routes/clients.routes.js';
import { vaultRoutes, credentialRoutes } from './features/os/routes/vault.routes.js';
import trackerRoutes from './features/os/routes/tracker.routes.js';
import { overviewRoutes, serviceCatalogRoutes, industryCatalogRoutes } from './features/os/routes/overview.routes.js';
import {
  referrerRoutes, referralRoutes, jobRoutes, jobApplicationRoutes, egaRoutes, newsletterRoutes,
  magazineIssueRoutes, magazineArticleRoutes, newsletterTemplateRoutes, newsletterCampaignRoutes,
} from './features/os/routes/growth.routes.js';
import {
  assetRoutes, knowledgeCategoryRoutes, knowledgeArticleRoutes, contentCalendarRoutes, leaveRoutes,
  sowTemplateRoutes, sowDocumentRoutes, portalOpsRoutes,
} from './features/os/routes/agency.routes.js';
import { salesCrmRoutes } from './features/os/routes/salescrm.routes.js';
import { publicRoutes } from './features/os/routes/public.routes.js';
import { cronRoutes } from './features/os/routes/cron.routes.js';
import { settingsRoutes } from './features/os/routes/settings.routes.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(createCorsOptions(env.CORS_ORIGIN)));
if (env.NODE_ENV !== 'test') app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR)));

app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Agency ERP API',
    health: '/api/health',
    api: '/api/v1',
  });
});

app.get('/api/health', async (_req, res) => {
  let database = getDatabaseStatus();
  let dbError: string | undefined;
  try {
    await connectDatabase();
    database = getDatabaseStatus();
  } catch (error) {
    database = 'disconnected';
    dbError = (error as Error).message?.slice(0, 200) || 'MongoDB connection failed';
  }
  res.status(dbError ? 503 : 200).json({
    success: !dbError,
    message: dbError ? 'Agency ERP API is up but database is unreachable' : 'Agency ERP API is running',
    version: '1.0.0',
    database,
    ...(dbError ? { dbError } : {}),
  });
});

app.use(async (_req, _res, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

const v1 = express.Router();
v1.use('/auth', authRoutes);
v1.use('/dashboard', dashboardRoutes);
v1.use('/lead-categories', leadCategoryRoutes);
v1.use('/leads', leadRoutes);
v1.use('/tasks', taskRoutes);
v1.use('/notifications', notificationRoutes);
v1.use('/imports', importRoutes);
v1.use('/calls', callRoutes);
v1.use('/follow-ups', followUpRoutes);
v1.use('/proposals', proposalRoutes);
v1.use('/saved-views', savedViewRoutes);
v1.use('/projects', projectRoutes);
v1.use('/invoices', invoiceRoutes);
v1.use('/expenses', expenseRoutes);
v1.use('/finance', financeRoutes);
v1.use('/users', userRoutes);
v1.use('/automation', automationRoutes);
v1.use('/admin', adminRoutes);
v1.use('/activity', activityRoutes);
v1.use('/access-requests', accessRequestRoutes);

v1.use('/os', overviewRoutes);
v1.use('/services', serviceCatalogRoutes);
v1.use('/industries', industryCatalogRoutes);
v1.use('/conversions', conversionRoutes);
v1.use('/clients', vendorRoutes);
v1.use('/vault', vaultRoutes);
v1.use('/credentials', credentialRoutes);
v1.use('/tracker', trackerRoutes);
v1.use('/meetings', meetingRoutes);
v1.use('/documents', documentRoutes);
v1.use('/payments', paymentRoutes);
v1.use('/recurring-payments', recurringPaymentRoutes);
v1.use('/transactions', transactionRoutes);
v1.use('/revenue', revenueRoutes);
v1.use('/growth/referrers', referrerRoutes);
v1.use('/growth/referrals', referralRoutes);
v1.use('/growth/jobs', jobRoutes);
v1.use('/growth/applications', jobApplicationRoutes);
v1.use('/growth/ega', egaRoutes);
v1.use('/growth/newsletter/templates', newsletterTemplateRoutes);
v1.use('/growth/newsletter/campaigns', newsletterCampaignRoutes);
v1.use('/growth/newsletter', newsletterRoutes);
v1.use('/growth/magazine/issues', magazineIssueRoutes);
v1.use('/growth/magazine/articles', magazineArticleRoutes);
v1.use('/sales-crm', salesCrmRoutes);
v1.use('/assets', assetRoutes);
v1.use('/knowledge/categories', knowledgeCategoryRoutes);
v1.use('/knowledge/articles', knowledgeArticleRoutes);
v1.use('/content-calendar', contentCalendarRoutes);
v1.use('/leave', leaveRoutes);
v1.use('/sow-templates', sowTemplateRoutes);
v1.use('/sows', sowDocumentRoutes);
v1.use('/portal-ops', portalOpsRoutes);
v1.use('/public/:orgSlug', publicRoutes);
v1.use('/cron', cronRoutes);
v1.use('/settings', settingsRoutes);

app.use('/api/v1', v1);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
