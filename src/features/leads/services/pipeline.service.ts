import { Types } from 'mongoose';
import { Lead, LeadActivity, User } from '../../../models/index.js';
import type { LeadStatus } from '../../../models/Lead.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';

/** The funnel every lead moves through; `converted` is reached via "Convert to client", not the board. */
export const PIPELINE_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'converted'] as const;
export const BOARD_COLUMNS = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'lost', 'on_hold'] as const;
type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Legacy CRM statuses folded into the funnel stage they represent. */
const STAGE_OF: Record<LeadStatus, BoardColumn | 'converted'> = {
  new: 'new', not_contacted: 'new',
  contacted: 'contacted', attempt_1: 'contacted', attempt_2: 'contacted', connected: 'contacted',
  qualified: 'qualified', interested: 'qualified', meeting: 'qualified', demo: 'qualified',
  proposal: 'proposal',
  negotiation: 'negotiation',
  converted: 'converted', won: 'converted',
  lost: 'lost',
  on_hold: 'on_hold', future_follow_up: 'on_hold', dormant: 'on_hold',
};

const stageIndex = (status?: unknown) => {
  const stage = STAGE_OF[status as LeadStatus];
  return stage ? (PIPELINE_STAGES as readonly string[]).indexOf(stage) : -1;
};

export const PIPELINE_RANGES = { all: 0, '30d': 30, '90d': 90, '365d': 365 } as const;

export interface PipelineFilters {
  range?: keyof typeof PIPELINE_RANGES;
  owner?: string;
  source?: string;
  categoryId?: string;
}

export async function pipelineAnalytics(organizationId: string, filters: PipelineFilters) {
  const base: Record<string, unknown> = { organizationId: new Types.ObjectId(organizationId), isArchived: false };
  const days = PIPELINE_RANGES[filters.range || 'all'];
  const query: Record<string, unknown> = { ...base };
  if (days) query.createdAt = { $gte: new Date(Date.now() - days * 86_400_000) };
  if (filters.owner && Types.ObjectId.isValid(filters.owner)) query.assignedTo = new Types.ObjectId(filters.owner);
  if (filters.source) query.source = filters.source;
  if (filters.categoryId && Types.ObjectId.isValid(filters.categoryId)) query.categoryId = new Types.ObjectId(filters.categoryId);

  const [leads, ownerIds, sources] = await Promise.all([
    Lead.find(query)
      .select('firstName lastName company status estimatedValue assignedTo source updatedAt')
      .populate('assignedTo', 'firstName lastName')
      .sort({ updatedAt: -1 })
      .lean(),
    Lead.distinct('assignedTo', base),
    Lead.distinct('source', base),
  ]);

  const ids = leads.map((l) => l._id);
  const history = ids.length
    ? await LeadActivity.find({ organizationId, leadId: { $in: ids }, type: 'status_change' }).select('leadId metadata').lean()
    : [];

  // Furthest stage each lead ever reached, so a lead that dropped to "lost" after a proposal still counts as having had one.
  const furthest = new Map<string, number>(leads.map((l) => [String(l._id), Math.max(0, stageIndex(l.status))]));
  for (const a of history) {
    const id = String(a.leadId);
    const meta = (a.metadata || {}) as { from?: string; to?: string };
    furthest.set(id, Math.max(furthest.get(id) ?? 0, stageIndex(meta.from), stageIndex(meta.to)));
  }
  const reached = PIPELINE_STAGES.map((_, i) => [...furthest.values()].filter((f) => f >= i).length);

  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, { leads: [] as unknown[], total: 0 }])) as Record<BoardColumn, { leads: unknown[]; total: number }>;
  let openValue = 0;
  let openCount = 0;
  for (const lead of leads) {
    const stage = STAGE_OF[lead.status as LeadStatus];
    if (!stage || stage === 'converted') continue;
    const value = Number(lead.estimatedValue) || 0;
    columns[stage].leads.push(lead);
    columns[stage].total += value;
    if (stage !== 'lost' && stage !== 'on_hold') {
      openValue += value;
      openCount++;
    }
  }

  const lost = columns.lost.leads.length;
  const converted = reached[PIPELINE_STAGES.length - 1];
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds.filter(Boolean) } }).select('firstName lastName').sort({ firstName: 1 }).lean()
    : [];

  return {
    total: leads.length,
    stages: PIPELINE_STAGES.map((key, i) => ({ key, reached: reached[i] })),
    openValue,
    openCount,
    converted,
    lost,
    onHold: columns.on_hold.leads.length,
    winRate: converted + lost ? (converted / (converted + lost)) * 100 : 0,
    columns: BOARD_COLUMNS.map((key) => ({ key, ...columns[key] })),
    owners: owners.map((u) => ({ id: String(u._id), name: `${u.firstName} ${u.lastName}`.trim() })),
    sources: (sources as string[]).filter(Boolean).sort(),
  };
}

/** Board moves always record who moved the lead, where from and why. */
export async function moveLead(organizationId: string, userId: string, leadId: string, to: BoardColumn, reason: string) {
  if (!Types.ObjectId.isValid(leadId)) throw new NotFoundError('Lead');
  const lead = await Lead.findOne({ _id: leadId, organizationId, isArchived: false });
  if (!lead) throw new NotFoundError('Lead');
  if (STAGE_OF[lead.status] === 'converted') throw new ValidationError('Converted leads are managed under Conversions');
  if (STAGE_OF[lead.status] === to) return lead;

  const from = lead.status;
  lead.status = to;
  await lead.save();
  await LeadActivity.create({
    organizationId,
    leadId: lead._id,
    type: 'status_change',
    title: `Moved to ${to.replace('_', ' ')}`,
    description: reason,
    metadata: { from, to, reason },
    createdBy: userId,
  });
  return lead;
}
