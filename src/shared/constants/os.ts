export const RECORD_STATUSES = ['active', 'archived', 'cancelled'] as const;

export const LEAD_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const LEAD_SOURCES = ['inbound', 'website', 'referral', 'cold', 'partner', 'other'] as const;

export const PROJECT_STATUSES = [
  'planned', 'onboarding', 'in_progress', 'waiting_for_client', 'blocked', 'in_review', 'completed', 'cancelled',
] as const;
export const LEGACY_PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'not_started', 'client_review', 'revision'] as const;
export const ACTIVE_PROJECT_STATUSES = ['planned', 'onboarding', 'in_progress', 'waiting_for_client', 'blocked', 'in_review'];
export const LEGACY_PROJECT_STATUS_MAP: Record<string, string> = {
  not_started: 'planned', planning: 'onboarding', active: 'in_progress', in_progress: 'in_progress',
  client_review: 'in_review', revision: 'in_progress', on_hold: 'blocked', completed: 'completed', cancelled: 'cancelled',
};
export function normalizeProjectStatus(s?: string | null): string {
  if (!s) return 'planned';
  if ((PROJECT_STATUSES as readonly string[]).includes(s)) return s;
  return LEGACY_PROJECT_STATUS_MAP[s] ?? 'planned';
}
export const PROJECT_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const DEFAULT_PROJECT_MILESTONES = ['Discovery', 'Design', 'Development', 'Testing', 'Launch'];

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'on_hold', 'completed', 'cancelled'] as const;
export const LEGACY_TASK_STATUSES = ['pending', 'assigned', 'review', 'overdue'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const MEETING_TYPES = ['kickoff', 'strategy', 'review', 'internal', 'other'] as const;
export const MILESTONE_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const VISIBILITY_LEVELS = ['internal', 'client_visible'] as const;

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const DEFAULT_TAX_RATE = 0.18;
export const DEFAULT_HSN_SAC = '998314';

export const TRANSACTION_TYPES = ['income', 'expense'] as const;
export const TRANSACTION_PAYMENT_METHODS = ['upi', 'bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;
export const TRANSACTION_HISTORY_ACTIONS = ['created', 'updated', 'deleted'] as const;
export const RECURRING_PAYMENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const RECURRING_PAYMENT_STATUSES = ['active', 'paused', 'ended'] as const;

export const DEFAULT_SERVICES = [
  { slug: 'website', name: 'Website' }, { slug: 'seo', name: 'SEO' }, { slug: 'crm', name: 'CRM' },
  { slug: 'ai_agent', name: 'AI Agent' }, { slug: 'automation', name: 'Automation' }, { slug: 'branding', name: 'Branding' },
];

export const DEFAULT_INDUSTRIES = [
  { slug: 'saas', name: 'SaaS / Technology', sector: 'Technology' },
  { slug: 'healthcare', name: 'Healthcare', sector: 'Healthcare & Life Sciences' },
  { slug: 'education', name: 'Education', sector: 'Education' },
  { slug: 'fintech', name: 'Fintech', sector: 'Financial Services' },
  { slug: 'banking', name: 'Banking / Insurance', sector: 'Financial Services' },
  { slug: 'ecommerce', name: 'E-commerce', sector: 'Retail & Commerce' },
  { slug: 'retail', name: 'Retail', sector: 'Retail & Commerce' },
  { slug: 'real_estate', name: 'Real Estate', sector: 'Real Estate & Construction' },
  { slug: 'manufacturing', name: 'Manufacturing', sector: 'Manufacturing & Industry' },
  { slug: 'hospitality', name: 'Hospitality', sector: 'Travel & Hospitality' },
  { slug: 'logistics', name: 'Logistics', sector: 'Logistics & Transport' },
  { slug: 'agency', name: 'Agency / Marketing', sector: 'Professional Services' },
  { slug: 'legal', name: 'Legal', sector: 'Professional Services' },
  { slug: 'media', name: 'Media & Entertainment', sector: 'Media & Entertainment' },
  { slug: 'other', name: 'Other', sector: 'Other' },
];

export const VAULT_PROJECT_STATUSES = ['active', 'inactive', 'archived'] as const;
export const VAULT_MESSAGE_TYPES = ['whatsapp_cold', 'email', 'follow_up', 'linkedin', 'general_pitch'] as const;
export const PITCH_STATUSES = ['pitched', 'interested', 'follow_up', 'demo', 'negotiation', 'working', 'won', 'lost'] as const;
export const PITCH_WORKING_STATUSES = ['interested', 'follow_up', 'demo', 'negotiation', 'working'];
export const PITCH_FUNNEL_ORDER = ['pitched', 'interested', 'follow_up', 'demo', 'negotiation', 'working', 'won'];

export const TRACKER_STATUSES = ['started', 'in_progress', 'completed', 'not_needed', 'blocked', 'recursive', 'not_yet_started'] as const;
export const TRACKER_DONE_STATUSES = ['completed', 'not_needed'];
export const TRACKER_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export const TRACKER_PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export const TRACKER_KINDS = ['deadline', 'daily'] as const;

export const CONVERSION_CODE_PREFIX = 'ECM';

// Growth
export const REFERRAL_STAGES = ['submitted', 'contacted', 'qualified_call', 'proposal_sent', 'won', 'lost'] as const;
export const REFERRAL_PROJECT_TYPES = [
  { value: 'website', label: 'Website only', baseReward: 3000 },
  { value: 'website_crm', label: 'Website + CRM/Automation', baseReward: 7000 },
  { value: 'ai_growth', label: 'AI Calling Agent / Full Growth System', baseReward: 15000 },
] as const;
export const REFERRER_TIERS = ['standard', 'growth_partner', 'elite_partner'] as const;
export const TIER_BONUS: Record<string, number> = { standard: 0, growth_partner: 0.2, elite_partner: 0.3 };
export const LOST_REASONS = ['timing', 'budget', 'went_elsewhere', 'not_a_fit', 'no_response', 'other'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'freelance'] as const;
export const JOB_STATUSES = ['draft', 'published', 'closed'] as const;
export const APPLICATION_STATUSES = ['new', 'reviewing', 'shortlisted', 'rejected', 'hired'] as const;
export const EGA_STATUSES = ['pending', 'selected', 'lookback', 'rejected'] as const;

// Sales CRM
export const SALES_EMPLOYEE_STATUSES = ['active', 'inactive', 'on_leave'] as const;
export const SALES_LEAD_SOURCES = ['website', 'referral', 'instagram', 'facebook', 'linkedin', 'google', 'ads', 'campaign', 'cold_outreach', 'existing_customer', 'other'] as const;
export const SALES_LEAD_TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export const SALES_LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost'] as const;
export const SALES_DEAL_STAGES = ['new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost'] as const;
export const SALES_LOST_REASONS = ['price_objection', 'timing_issue', 'requirement_mismatch', 'chose_competitor', 'no_response', 'other'] as const;
/** Outcomes an employee can pick after a call. Legacy values stay so older logs still validate. */
export const SALES_CALL_FORM_OUTCOMES = ['interested', 'not_interested', 'follow_up', 'callback', 'no_answer', 'busy', 'wrong_number', 'other'] as const;
export const SALES_CALL_OUTCOMES = [...SALES_CALL_FORM_OUTCOMES, 'connected', 'qualified'] as const;
export const SALES_CALL_STATUSES = ['initiated', 'dialing', 'awaiting_outcome', 'completed', 'cancelled'] as const;
export const SALES_CALL_CHANNELS = ['this_device', 'os_phone_link', 'linked_phone', 'manual'] as const;
export const SALES_CALL_PROVIDERS = ['device_sim', 'voip'] as const;
export const SALES_CALL_DURATION_SOURCES = ['unavailable', 'phone_return', 'crm_timer'] as const;
/** Someone answered. Busy and no-answer are attempts that did not connect. */
export const SALES_CONNECTED_CALL_OUTCOMES = ['interested', 'not_interested', 'follow_up', 'callback', 'other', 'wrong_number', 'connected', 'qualified'] as const;
export const SALES_MEETING_TYPES = ['discovery', 'demo', 'proposal', 'negotiation', 'internal', 'other'] as const;
export const SALES_MEETING_STATUSES = ['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show'] as const;
export const SALES_FOLLOWUP_TYPES = ['call', 'email', 'whatsapp', 'meeting', 'other'] as const;
export const SALES_FOLLOWUP_STATUSES = ['pending', 'completed', 'missed', 'cancelled'] as const;
export const SALES_QUOTATION_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'viewed', 'accepted', 'rejected', 'expired'] as const;
export const SALES_PROPOSAL_STATUSES = ['draft', 'review', 'approved', 'sent', 'viewed', 'accepted', 'rejected'] as const;
export const SALES_TASK_STATUSES = ['todo', 'in_progress', 'completed', 'overdue'] as const;
export const SALES_APPROVAL_TYPES = ['discount', 'quotation', 'proposal', 'deal'] as const;
export const SALES_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const SALES_ATTENDANCE_STATUSES = ['present', 'absent', 'leave', 'half_day', 'late'] as const;
export const SALES_TARGET_PERIODS = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
export const SALES_TERRITORY_TYPES = ['city', 'state', 'region', 'country', 'custom'] as const;

export const SALES_MODULES = [
  'dashboard.sales', 'dashboard.manager', 'leads.management', 'leads.qualification', 'leads.assignment',
  'sales.pipeline', 'sales.deals', 'sales.negotiation', 'sales.closure', 'sales.forecast',
  'customers.management', 'customers.documents', 'comm.calls', 'comm.meetings', 'comm.followups', 'comm.email_whatsapp',
  'docs.quotations', 'docs.proposals', 'docs.sales_documents', 'perf.targets', 'perf.performance', 'perf.leaderboard',
  'perf.daily_report', 'perf.productivity', 'perf.daily_work_status', 'workforce.attendance_sync',
  'workforce.attendance_dashboard', 'workforce.live_status', 'workforce.activity_tracking', 'workforce.activity_timeline',
  'tasks.management', 'tasks.calendar', 'analytics.revenue', 'analytics.conversion', 'analytics.lead_source',
  'analytics.lost_deals', 'reports.reports', 'reports.export', 'growth.ega', 'growth.ega_form', 'growth.applications',
  'admin.notifications', 'admin.approvals', 'admin.teams', 'admin.territories', 'admin.audit_logs',
] as const;
/** Full LeadSquared-style BDA defaults. Admin-only keys stay forced off via SALES_ADMIN_ONLY_MODULES. */
export const DEFAULT_EMPLOYEE_MODULES = [
  'dashboard.sales',
  'leads.management', 'leads.qualification',
  'sales.pipeline', 'sales.deals', 'sales.negotiation', 'sales.closure', 'sales.forecast',
  'customers.management', 'customers.documents',
  'comm.calls', 'comm.meetings', 'comm.followups', 'comm.email_whatsapp',
  'docs.quotations', 'docs.proposals', 'docs.sales_documents',
  'perf.targets', 'perf.performance', 'perf.leaderboard', 'perf.daily_report', 'perf.productivity', 'perf.daily_work_status',
  'workforce.attendance_sync',
  'tasks.management', 'tasks.calendar',
  'admin.notifications', 'admin.approvals',
];
export const SALES_ADMIN_ONLY_MODULES = [
  'dashboard.manager', 'leads.assignment', 'workforce.attendance_dashboard', 'workforce.live_status',
  'workforce.activity_tracking', 'workforce.activity_timeline', 'analytics.revenue', 'analytics.conversion',
  'analytics.lead_source', 'analytics.lost_deals', 'reports.reports', 'reports.export', 'admin.teams',
  'admin.territories', 'admin.audit_logs',
];

/** Extra addresses a company can route its notification emails to, on top of the users who already receive them. */
export const NOTIFICATION_CATEGORIES = ['finance', 'sales', 'tasks', 'careers', 'referrals', 'ega', 'alerts'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const COMPANY_PROFILE_FIELDS = [
  'legalName', 'address', 'email', 'phone', 'gst', 'pan', 'cin', 'state', 'stateCode', 'jurisdiction',
  'bankName', 'bankAccountName', 'bankAccountNumber', 'bankIfsc', 'bankAccountType', 'bankUpi',
] as const;
export type CompanyProfileField = (typeof COMPANY_PROFILE_FIELDS)[number];
