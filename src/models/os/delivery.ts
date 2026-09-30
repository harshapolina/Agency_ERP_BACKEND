import { osModel, osSchema, ref, str, oneOf } from './base.js';
import { MILESTONE_STATUSES, VISIBILITY_LEVELS, MEETING_TYPES } from '../../shared/constants/os.js';

const projectMemberSchema = osSchema({
  projectId: ref('Project', { required: true, index: true }),
  userId: ref('User', { required: true, index: true }),
  roleOnProject: oneOf(['member', 'poc'], 'member'),
});
projectMemberSchema.index({ organizationId: 1, projectId: 1, userId: 1 }, { unique: true });
export const ProjectMember = osModel('ProjectMember', projectMemberSchema);

const projectUpdateSchema = osSchema({
  projectId: ref('Project', { required: true, index: true }),
  conversionUuid: str({ index: true }),
  title: { type: String, required: true, trim: true },
  body: str(),
  visibility: oneOf(VISIBILITY_LEVELS, 'internal'),
  publishedAt: Date,
});
export const ProjectUpdate = osModel('ProjectUpdate', projectUpdateSchema);

const milestoneSchema = osSchema({
  projectId: ref('Project', { required: true, index: true }),
  conversionUuid: str({ index: true }),
  name: { type: String, required: true, trim: true },
  description: str(),
  sortOrder: { type: Number, default: 0 },
  status: oneOf(MILESTONE_STATUSES, 'pending'),
  weight: { type: Number, default: 1 },
  dueDate: Date,
  completedAt: Date,
  visibleToClient: { type: Boolean, default: true },
});
export const Milestone = osModel('Milestone', milestoneSchema);

const taskCommentSchema = osSchema({
  taskId: ref('Task', { required: true, index: true }),
  userId: ref('User', { required: true }),
  message: { type: String, required: true, trim: true },
});
export const TaskComment = osModel('TaskComment', taskCommentSchema);

const taskDependencySchema = osSchema(
  {
    taskId: ref('Task', { required: true, index: true }),
    dependsOnTaskId: ref('Task', { required: true, index: true }),
    dependencyType: oneOf(['blocks'], 'blocks'),
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
taskDependencySchema.index({ organizationId: 1, taskId: 1, dependsOnTaskId: 1 }, { unique: true });
export const TaskDependency = osModel('TaskDependency', taskDependencySchema);

const workSessionSchema = osSchema(
  {
    taskId: ref('Task', { required: true, index: true }),
    userId: ref('User', { required: true, index: true }),
    startedAt: { type: Date, required: true },
    endedAt: Date,
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
export const TaskWorkSession = osModel('TaskWorkSession', workSessionSchema);

const meetingSchema = osSchema({
  conversionUuid: str({ index: true }),
  projectId: ref('Project', { index: true }),
  vendorId: ref('Vendor'),
  title: { type: String, required: true, trim: true },
  startsAt: { type: Date, required: true },
  location: str(),
  participants: str(),
  meetingType: oneOf(MEETING_TYPES, 'other'),
  discussion: str(),
  decisions: str(),
  actionItems: str(),
  nextFollowUp: Date,
  attachmentsNote: str(),
  visibleToClient: { type: Boolean, default: false },
});
export const Meeting = osModel('Meeting', meetingSchema);

const documentSchema = osSchema({
  conversionUuid: str({ index: true }),
  projectId: ref('Project'),
  vendorId: ref('Vendor'),
  title: { type: String, required: true, trim: true },
  fileName: str(),
  mimeType: str(),
  size: { type: Number, default: 0 },
  dataBase64: { type: String, default: '', select: false },
  visibleToClient: { type: Boolean, default: false },
});
export const OsDocument = osModel('OsDocument', documentSchema);

const portalAccessSchema = osSchema({
  conversionUuid: { type: String, required: true },
  tokenHash: { type: String, required: true },
  tokenHint: str(),
  tokenCipher: { type: String, select: false },
  tokenIv: { type: String, select: false },
  tokenTag: { type: String, select: false },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
});
portalAccessSchema.index({ organizationId: 1, conversionUuid: 1 }, { unique: true });
portalAccessSchema.index({ tokenHash: 1 }, { unique: true });
export const PortalAccess = osModel('PortalAccess', portalAccessSchema);
