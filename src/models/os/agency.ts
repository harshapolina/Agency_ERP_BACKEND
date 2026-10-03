import { Schema } from 'mongoose';
import { osModel, osSchema, ref, str, oneOf } from './base.js';

export const AgencyAsset = osModel('AgencyAsset', osSchema({
  title: { type: String, required: true, trim: true },
  folder: str({ default: 'Library' }),
  tags: { type: [String], default: [] },
  kind: oneOf(['image', 'video', 'document', 'other'], 'document'),
  fileName: str(),
  mimeType: str(),
  size: { type: Number, default: 0 },
  dataBase64: { type: String, default: '', select: false },
  projectId: ref('Project'),
  conversionUuid: str(),
  notes: str(),
}));

export const KnowledgeCategory = osModel('KnowledgeCategory', osSchema({
  name: { type: String, required: true, trim: true },
  description: str(),
  sortOrder: { type: Number, default: 0 },
}));

export const KnowledgeArticle = osModel('KnowledgeArticle', osSchema({
  categoryId: ref('KnowledgeCategory'),
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  audience: oneOf(['all', 'sales', 'delivery', 'ops'], 'all'),
  status: oneOf(['draft', 'published'], 'published', { index: true }),
}));

export const ContentPost = osModel('ContentPost', osSchema({
  title: { type: String, required: true, trim: true },
  channel: oneOf(['instagram', 'linkedin', 'facebook', 'youtube', 'blog', 'magazine', 'email', 'other'], 'instagram'),
  status: oneOf(['idea', 'draft', 'scheduled', 'published', 'cancelled'], 'idea', { index: true }),
  scheduledAt: Date,
  publishedAt: Date,
  ownerName: str(),
  caption: str(),
  articleId: ref('MagazineArticle'),
  assetId: ref('AgencyAsset'),
  notes: str(),
}));

export const LeaveRequest = osModel('LeaveRequest', osSchema({
  userId: ref('User', { required: true, index: true }),
  employeeName: str(),
  type: oneOf(['casual', 'sick', 'earned', 'unpaid', 'other'], 'casual'),
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  days: { type: Number, default: 1 },
  reason: str(),
  status: oneOf(['pending', 'approved', 'rejected', 'cancelled'], 'pending', { index: true }),
  reviewerName: str(),
  reviewerComment: str(),
  decidedAt: Date,
}));

export const SowTemplate = osModel('SowTemplate', osSchema({
  name: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  defaultTermDays: { type: Number, default: 14 },
}));

export const SowDocument = osModel('SowDocument', osSchema({
  templateId: ref('SowTemplate'),
  title: { type: String, required: true, trim: true },
  clientName: str(),
  projectName: str(),
  conversionUuid: str(),
  dealId: str(),
  body: str(),
  status: oneOf(['draft', 'sent', 'signed', 'void'], 'draft'),
  html: str(),
}));

export const PortalComment = osModel('PortalComment', osSchema({
  conversionUuid: { type: String, required: true, index: true },
  authorType: oneOf(['client', 'staff'], 'client'),
  authorName: str(),
  body: { type: String, required: true, trim: true },
}));

export const PortalApproval = osModel('PortalApproval', osSchema({
  conversionUuid: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true },
  detail: str(),
  kind: oneOf(['proof', 'sow', 'brief', 'other'], 'proof'),
  status: oneOf(['pending', 'approved', 'changes_requested'], 'pending', { index: true }),
  clientComment: str(),
  decidedAt: Date,
}));

export const PortalTicket = osModel('PortalTicket', osSchema({
  conversionUuid: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true },
  body: str(),
  kind: oneOf(['change_request', 'brief', 'issue', 'question'], 'question'),
  status: oneOf(['open', 'in_progress', 'resolved', 'closed'], 'open', { index: true }),
  staffReply: str(),
}));
