import { SalesEmployee, nextSequence } from '../../../models/index.js';

async function nextEmployeeCode(organizationId: string, isSalesAdmin: boolean) {
  const seq = await nextSequence(
    organizationId,
    isSalesAdmin ? 'sales:SA' : 'sales:SE',
    await SalesEmployee.countDocuments({ organizationId, isSalesAdmin })
  );
  return `${isSalesAdmin ? 'SA' : 'SE'}-${String(seq).padStart(4, '0')}`;
}

/** Creates a SalesEmployee for a company user if one does not already exist (BDA / sales admin identity). */
export async function ensureSalesEmployeeForUser(opts: {
  organizationId: string;
  userId: string;
  email: string;
  isSalesAdmin?: boolean;
  phone?: string;
  department?: string;
  team?: string;
  territory?: string;
}) {
  const existing = await SalesEmployee.findOne({
    organizationId: opts.organizationId,
    userId: opts.userId,
  });
  if (existing) return existing;

  const isSalesAdmin = Boolean(opts.isSalesAdmin);
  return SalesEmployee.create({
    organizationId: opts.organizationId,
    userId: opts.userId,
    isSalesAdmin,
    employeeCode: await nextEmployeeCode(opts.organizationId, isSalesAdmin),
    department: opts.department?.trim() || 'Sales',
    team: opts.team || '',
    territory: opts.territory || '',
    phone: opts.phone || '',
    status: 'active',
    createdBy: opts.email,
    updatedBy: opts.email,
  });
}
