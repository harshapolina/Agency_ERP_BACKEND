import { SalesCall, SalesEmployee, User } from '../../../models/index.js';
import { SALES_CONNECTED_CALL_OUTCOMES } from '../../../shared/constants/os.js';

const CONNECTED = new Set<string>(SALES_CONNECTED_CALL_OUTCOMES);

export function loggedCallMatch() {
  return {
    $or: [
      { status: { $in: ['completed', 'awaiting_outcome'] } },
      { status: { $exists: false } },
      { status: '' },
    ],
  };
}

function secondsOf(call: object) {
  const row = call as { durationSeconds?: number | null; durationMinutes?: number };
  if (typeof row.durationSeconds === 'number' && row.durationSeconds >= 0) return row.durationSeconds;
  if (row.durationMinutes) return Math.round(row.durationMinutes * 60);
  return null;
}

function personName(user?: { firstName?: string; lastName?: string } | null) {
  if (!user) return 'Employee';
  return [user.firstName, user.lastName === '-' ? '' : user.lastName].filter(Boolean).join(' ') || 'Employee';
}

/** Today's completed calls. Duration is whatever the CRM timed — never a carrier record. */
export async function buildCallAnalytics(organizationId: string, employeeId?: string) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const filter: Record<string, unknown> = {
    organizationId,
    recordStatus: 'active',
    calledAt: { $gte: todayStart, $lt: todayEnd },
    $or: [{ status: 'completed' }, { status: { $exists: false } }, { status: '' }],
  };
  if (employeeId) filter.employeeId = employeeId;

  const calls = await SalesCall.find(filter).select('outcome durationSeconds durationMinutes employeeId leadId nextFollowUpAt').lean();
  const interestedLeads = new Set<string>();
  const byEmp = new Map<string, number>();
  let duration = 0;
  let measured = 0;
  let connectedCalls = 0;
  let noAnswerCalls = 0;
  let followUpsCreated = 0;

  for (const call of calls) {
    if (CONNECTED.has(String(call.outcome || ''))) connectedCalls += 1;
    if (call.outcome === 'no_answer') noAnswerCalls += 1;
    if (call.outcome === 'interested' && call.leadId) interestedLeads.add(String(call.leadId));
    if (call.nextFollowUpAt) followUpsCreated += 1;
    const seconds = secondsOf(call);
    if (seconds != null) {
      duration += seconds;
      measured += 1;
    }
    const id = String(call.employeeId || '');
    if (id) byEmp.set(id, (byEmp.get(id) || 0) + 1);
  }

  let byEmployee: { employeeId: string; name: string; calls: number }[] = [];
  if (!employeeId && byEmp.size) {
    const employees = await SalesEmployee.find({ organizationId, _id: { $in: [...byEmp.keys()] } }).select('userId').lean();
    const users = await User.find({ organizationId, _id: { $in: employees.map((e) => e.userId) } }).select('firstName lastName').lean();
    byEmployee = employees
      .map((employee) => {
        const user = users.find((row) => String(row._id) === String(employee.userId));
        return { employeeId: String(employee._id), name: personName(user), calls: byEmp.get(String(employee._id)) || 0 };
      })
      .sort((a, b) => b.calls - a.calls);
  }

  return {
    totalCalls: calls.length,
    connectedCalls,
    noAnswerCalls,
    totalDurationSeconds: measured ? duration : null,
    interestedLeads: interestedLeads.size,
    followUpsCreated,
    byEmployee,
  };
}

export async function withCallerNames<T extends object>(organizationId: string, calls: T[]) {
  const ids = [...new Set(calls.map((call) => String((call as { employeeId?: unknown }).employeeId || '')).filter(Boolean))];
  if (!ids.length) return calls.map((call) => ({ ...call, callerName: '' }));
  const employees = await SalesEmployee.find({ organizationId, _id: { $in: ids } }).select('userId').lean();
  const users = await User.find({ _id: { $in: employees.map((e) => e.userId) } }).select('firstName lastName').lean();
  const names = new Map(employees.map((employee) => {
    const user = users.find((row) => String(row._id) === String(employee.userId));
    return [String(employee._id), personName(user)];
  }));
  return calls.map((call) => ({ ...call, callerName: names.get(String((call as { employeeId?: unknown }).employeeId || '')) || '' }));
}
