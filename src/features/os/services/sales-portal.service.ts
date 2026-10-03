import { SalesEmployee } from '../../../models/index.js';

/** Map a Sales CRM path to the portal the recipient actually uses (BDA vs Sales CRM admin). */
export async function salesPortalHref(organizationId: string, userId: string, salesCrmPath: string) {
  const emp = await SalesEmployee.findOne({
    organizationId,
    userId,
    recordStatus: { $ne: 'archived' },
  }).select('isSalesAdmin').lean();
  if (emp && !emp.isSalesAdmin) {
    if (salesCrmPath.startsWith('/sales-crm')) return salesCrmPath.replace(/^\/sales-crm/, '/bda');
    if (salesCrmPath.startsWith('/tasks')) return '/bda/tasks';
    if (salesCrmPath.startsWith('/notifications')) return '/bda/notifications';
    return `/bda${salesCrmPath.startsWith('/') ? '' : '/'}${salesCrmPath.replace(/^\//, '')}`;
  }
  return salesCrmPath;
}

export async function isBdaSalesUser(organizationId: string, userId: string) {
  const emp = await SalesEmployee.findOne({
    organizationId,
    userId,
    recordStatus: { $ne: 'archived' },
    status: { $ne: 'inactive' },
  }).select('isSalesAdmin').lean();
  return Boolean(emp && !emp.isSalesAdmin);
}
