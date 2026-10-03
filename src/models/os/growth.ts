import { Schema } from 'mongoose';
import { osModel, osSchema, ref, str, oneOf } from './base.js';
import {
  REFERRAL_STAGES, REFERRER_TIERS, EMPLOYMENT_TYPES, JOB_STATUSES, APPLICATION_STATUSES,
} from '../../shared/constants/os.js';

const referrerSchema = osSchema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: str(),
  referralCode: { type: String, required: true, uppercase: true },
  tier: oneOf(REFERRER_TIERS, 'standard'),
  successfulReferralCount: { type: Number, default: 0 },
  totalRewardEarned: { type: Number, default: 0 },
  totalRewardPaid: { type: Number, default: 0 },
  isPublicPartner: { type: Boolean, default: false },
});
referrerSchema.index({ organizationId: 1, email: 1 }, { unique: true });
referrerSchema.index({ organizationId: 1, referralCode: 1 }, { unique: true });
export const Referrer = osModel('Referrer', referrerSchema);

const referralSchema = osSchema({
  referrerId: ref('Referrer', { required: true, index: true }),
  source: oneOf(['manual_submission', 'link_click'], 'manual_submission'),
  referredName: { type: String, required: true, trim: true },
  referredBusiness: str(),
  referredEmail: str({ lowercase: true, index: true }),
  referredPhone: str({ index: true }),
  referredNeeds: str(),
  referrerNotes: str(),
  consentToIntroEmail: { type: Boolean, default: false },
  mentionReferrerName: { type: Boolean, default: false },
  stage: oneOf(REFERRAL_STAGES, 'submitted', { index: true }),
  lostReason: str(),
  projectType: { type: String, enum: ['website', 'website_crm', 'ai_growth', ''], default: '' },
  projectValue: { type: Number, default: 0 },
  rewardAmount: { type: Number, default: 0 },
  rewardStatus: oneOf(['not_applicable', 'pending', 'paid'], 'not_applicable'),
  rewardPaidAt: Date,
  flaggedDuplicate: { type: Boolean, default: false },
  adminInternalNotes: str(),
  leadId: ref('Lead'),
  convertedAt: Date,
});
export const Referral = osModel('Referral', referralSchema);

const referralActivitySchema = osSchema(
  {
    referralId: ref('Referral', { required: true, index: true }),
    eventType: oneOf(['created', 'stage_change', 'note_added', 'reward_calculated', 'reward_paid'], 'created'),
    fromStage: str(),
    toStage: str(),
    note: str(),
    referrerVisible: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
export const ReferralActivity = osModel('ReferralActivity', referralActivitySchema);

const formFieldSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    placeholder: str(),
    helpText: str(),
    required: { type: Boolean, default: false },
    options: { type: [{ value: String, label: String }], default: undefined },
  },
  { _id: false }
);

const jobSchema = osSchema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  department: str(),
  location: str({ default: 'Remote' }),
  employmentType: oneOf(EMPLOYMENT_TYPES, 'full_time'),
  summary: str(),
  description: str(),
  requirements: str(),
  benefits: str(),
  status: oneOf(JOB_STATUSES, 'draft', { index: true }),
  formFields: { type: [formFieldSchema], default: [] },
  publishedAt: Date,
});
jobSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const Job = osModel('Job', jobSchema);

const jobApplicationSchema = osSchema({
  jobId: ref('Job', { required: true, index: true }),
  jobTitle: { type: String, required: true },
  status: oneOf(APPLICATION_STATUSES, 'new', { index: true }),
  applicantName: { type: String, required: true, trim: true },
  applicantEmail: str({ lowercase: true, index: true }),
  applicantPhone: str(),
  answers: { type: [Object], default: [] },
  adminNotes: str(),
});
export const JobApplication = osModel('JobApplication', jobApplicationSchema);

const egaSchema = osSchema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  phone: str(),
  college: str(),
  yearOfStudy: str(),
  specialization: str(),
  city: str(),
  about: str(),
  interests: { type: [String], default: [] },
  knowsOwners: str(),
  networkSize: str(),
  industries: { type: [String], default: [] },
  networkSources: { type: [String], default: [] },
  soldBefore: str(),
  salesExperience: str(),
  comfortApproach: { type: Number, default: 0 },
  comfortColdCall: { type: Number, default: 0 },
  comfortOutreach: { type: Number, default: 0 },
  websiteObjection: str(),
  rejectionResponse: str(),
  services: { type: [String], default: [] },
  exampleBusiness: str(),
  weeklyHours: str(),
  performanceBased: str(),
  training: str(),
  duration: str(),
  whySelect: str(),
  linkedin: str(),
  anythingElse: str(),
  status: oneOf(['pending', 'selected', 'lookback', 'rejected', 'shortlisted'], 'pending', { index: true }),
  score: { type: Number, default: 0, index: true },
  scoreBreakdown: { type: Object, default: {} },
  adminNotes: str(),
  answers: { type: Object, default: {} },
});
export const EGAApplication = osModel('EGAApplication', egaSchema);

const egaFormFieldSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    section: str({ default: 'Details' }),
    placeholder: str(),
    helpText: str(),
    required: { type: Boolean, default: false },
    options: { type: [{ value: String, label: String }], default: undefined },
    scoreMap: { type: Object, default: undefined },
    maxScore: { type: Number, default: undefined },
  },
  { _id: false }
);

const egaFormSchema = osSchema({
  title: str({ default: 'Growth Associate programme' }),
  subtitle: str(),
  published: { type: Boolean, default: true },
  fields: { type: [egaFormFieldSchema], default: [] },
});
export const EGAFormConfig = osModel('EGAFormConfig', egaFormSchema);

const newsletterSchema = osSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  source: str(),
  status: oneOf(['subscribed', 'unsubscribed'], 'subscribed'),
});
newsletterSchema.index({ organizationId: 1, email: 1 }, { unique: true });
export const NewsletterSubscriber = osModel('NewsletterSubscriber', newsletterSchema);

const newsletterTemplateSchema = osSchema({
  name: { type: String, required: true, trim: true },
  subject: str(),
  body: str(),
});
export const NewsletterTemplate = osModel('NewsletterTemplate', newsletterTemplateSchema);

const newsletterCampaignSchema = osSchema({
  subject: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  status: oneOf(['draft', 'sending', 'sent', 'failed'], 'draft', { index: true }),
  audience: str({ default: 'subscribed' }),
  articleId: ref('MagazineArticle'),
  sentAt: Date,
  recipientCount: { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  skippedSmtp: { type: Boolean, default: false },
  error: str(),
});
export const NewsletterCampaign = osModel('NewsletterCampaign', newsletterCampaignSchema);

const magazineIssueSchema = osSchema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  cover: str(),
  summary: str(),
  status: oneOf(['draft', 'published'], 'draft', { index: true }),
  publishedAt: Date,
});
magazineIssueSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const MagazineIssue = osModel('MagazineIssue', magazineIssueSchema);

const magazineArticleSchema = osSchema({
  issueId: ref('MagazineIssue'),
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  excerpt: str(),
  body: { type: String, required: true },
  cover: str(),
  tags: { type: [String], default: [] },
  status: oneOf(['draft', 'published'], 'draft', { index: true }),
  publishedAt: Date,
});
magazineArticleSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
export const MagazineArticle = osModel('MagazineArticle', magazineArticleSchema);
