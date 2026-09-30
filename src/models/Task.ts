import { Schema, Document, Types } from 'mongoose';
import { tenantModel } from '../config/tenant.js';
import { TASK_STATUSES, LEGACY_TASK_STATUSES, TASK_PRIORITIES, RECORD_STATUSES } from '../shared/constants/os.js';

export type TaskStatus = (typeof TASK_STATUSES)[number] | (typeof LEGACY_TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface ITask extends Document {
  organizationId: Types.ObjectId;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: Types.ObjectId;
  createdBy: Types.ObjectId;
  projectId?: Types.ObjectId;
  leadId?: Types.ObjectId;
  meetingId?: Types.ObjectId;
  conversionUuid?: string;
  parentTaskId?: Types.ObjectId;
  dueDate?: Date;
  startDate?: Date;
  actualStartTime?: Date;
  actualEndTime?: Date;
  completedAt?: Date;
  ownerSide: 'editco' | 'client';
  visibleToClient: boolean;
  clientActionRequired: boolean;
  checklist: Array<{ text: string; completed: boolean }>;
  tags: string[];
  estimatedHours?: number;
  actualHours?: number;
  isRecurring: boolean;
  recurringPattern?: string;
  recordStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<ITask>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: String,
    status: {
      type: String,
      enum: [...TASK_STATUSES, ...LEGACY_TASK_STATUSES],
      default: 'todo',
      index: true,
    },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'medium' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting' },
    conversionUuid: { type: String, index: true },
    parentTaskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    dueDate: { type: Date, index: true },
    startDate: Date,
    actualStartTime: Date,
    actualEndTime: Date,
    completedAt: Date,
    ownerSide: { type: String, enum: ['editco', 'client'], default: 'editco' },
    visibleToClient: { type: Boolean, default: false },
    clientActionRequired: { type: Boolean, default: false },
    checklist: [{ text: String, completed: { type: Boolean, default: false } }],
    tags: [String],
    estimatedHours: Number,
    actualHours: Number,
    isRecurring: { type: Boolean, default: false },
    recurringPattern: String,
    recordStatus: { type: String, enum: RECORD_STATUSES, default: 'active', index: true },
  },
  { timestamps: true }
);

taskSchema.index({ organizationId: 1, assignedTo: 1, status: 1, dueDate: 1 });

export const Task = tenantModel<ITask>('Task', taskSchema);
