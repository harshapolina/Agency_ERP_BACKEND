import { Request } from 'express';

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'manager'
  | 'sales'
  | 'project_manager'
  | 'team_member'
  | 'marketing'
  | 'hr'
  | 'finance'
  | 'operations'
  | 'developer'
  | 'viewer'
  | 'client';

export const ALL_ROLES: UserRole[] = [
  'super_admin', 'admin', 'manager', 'sales', 'project_manager', 'team_member',
  'marketing', 'hr', 'finance', 'operations', 'developer', 'viewer', 'client',
];

export const COMPANY_ROLES: UserRole[] = ALL_ROLES.filter((r) => r !== 'super_admin' && r !== 'client');

const ADMIN_OPS = [
  'users:read', 'leads:*', 'conversions:*', 'proposals:*', 'calls:*', 'followups:*',
  'pipeline:*', 'vendors:*', 'projects:*', 'meetings:*', 'tasks:*', 'documents:*',
  'milestones:*', 'project_updates:*', 'invoices:*', 'payments:*', 'finance:read',
  'dashboard:*', 'notifications:*', 'search:read', 'services:read', 'analytics:read',
  'vault:read', 'vault:write', 'vault:credentials', 'activity:read',
];

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  super_admin: ['*'],
  // Company admins own their workspace: everything inside it, including settings, tracker and growth.
  admin: [
    ...ADMIN_OPS, 'users:*', 'finance:*', 'reports:*', 'settings:*', 'categories:*', 'employees:*',
    'services:*', 'tracker:*', 'growth:*', 'sales_crm:*', 'audit:read', 'leaves:*', 'knowledge:*', 'campaigns:*',
  ],
  manager: [
    'leads:*', 'tasks:*', 'projects:read', 'projects:write', 'reports:read', 'dashboard:*',
    'pipeline:*', 'employees:read', 'notifications:*', 'categories:read', 'followups:*', 'calls:*',
    'proposals:*', 'conversions:read', 'vendors:read', 'meetings:*', 'search:read', 'activity:read',
    'analytics:read', 'vault:read', 'leaves:*', 'knowledge:*', 'documents:*',
  ],
  sales: [
    'leads:*', 'conversions:write', 'proposals:*', 'calls:*', 'followups:*', 'pipeline:*',
    'vendors:read', 'projects:read', 'meetings:read', 'dashboard:read', 'notifications:read',
    'search:read', 'services:read', 'analytics:read', 'vault:read', 'vault:write', 'activity:read',
    'tasks:read', 'tasks:write', 'categories:read', 'contacts:*', 'companies:*',
  ],
  project_manager: [
    'projects:*', 'meetings:*', 'tasks:*', 'documents:*', 'milestones:*', 'project_updates:*',
    'vendors:read', 'conversions:read', 'leads:read', 'proposals:read', 'followups:read',
    'dashboard:read', 'notifications:*', 'search:read', 'services:read', 'analytics:read',
    'vault:read', 'activity:read', 'knowledge:read',
  ],
  team_member: [
    'dashboard:read', 'notifications:*', 'projects:read', 'tasks:*', 'meetings:read',
    'documents:read', 'milestones:read', 'project_updates:read', 'search:read', 'activity:read',
    'knowledge:read', 'leaves:read', 'leaves:write',
  ],
  marketing: ['leads:read', 'dashboard:read', 'reports:read', 'campaigns:*', 'notifications:read', 'growth:*', 'knowledge:read'],
  hr: ['employees:*', 'attendance:*', 'leaves:*', 'dashboard:read', 'notifications:read', 'growth:*', 'knowledge:read'],
  finance: [
    'invoices:*', 'payments:*', 'finance:*', 'vendors:read', 'projects:read', 'conversions:read',
    'dashboard:read', 'notifications:read', 'search:read', 'analytics:read', 'activity:read', 'reports:read',
  ],
  operations: ['projects:*', 'tasks:*', 'dashboard:read', 'notifications:read', 'leads:read', 'meetings:*', 'documents:*', 'knowledge:read', 'campaigns:read'],
  developer: ['integrations:*', 'settings:read', 'dashboard:read', 'notifications:read', 'tasks:*', 'projects:read'],
  viewer: [
    'leads:read', 'conversions:read', 'proposals:read', 'calls:read', 'followups:read',
    'vendors:read', 'projects:read', 'milestones:read', 'project_updates:read', 'meetings:read',
    'tasks:read', 'documents:read', 'invoices:read', 'payments:read', 'dashboard:read',
    'notifications:read', 'search:read', 'analytics:read', 'services:read', 'finance:read',
    'vault:read', 'activity:read',
  ],
  client: ['portal:*', 'projects:read', 'invoices:read', 'documents:read', 'notifications:read'],
};

export function permissionsForRole(role: string, extra: string[] = []): string[] {
  const base = ROLE_PERMISSIONS[role as UserRole] ?? [];
  return Array.from(new Set([...base, ...extra]));
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  organizationId: string;
  permissions: string[];
  name?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * `*` grants everything; `resource:*` grants any action on the resource; `resource:write` implies
 * `resource:read`. Needing `*` itself is only satisfied by the `*` grant (platform super admin).
 */
export function permissionsAllow(perms: string[], needed: string): boolean {
  if (perms.includes('*') || perms.includes(needed)) return true;
  if (needed === '*') return false;
  const [resource, action] = needed.split(':');
  if (perms.includes(`${resource}:*`)) return true;
  if (action === 'read' && perms.includes(`${resource}:write`)) return true;
  return false;
}

export function hasPermission(user: AuthUser, permission: string): boolean {
  return permissionsAllow(user.permissions, permission);
}
