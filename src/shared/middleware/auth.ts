import { Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../errors/index.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { AuthenticatedRequest, hasPermission, permissionsForRole } from '../types/index.js';
import { connectionForOrganization, tenantStorage } from '../../config/tenant.js';

export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Access token required'));
  }

  try {
    const payload = verifyAccessToken(header.slice(7));
    // Permissions come from the role at request time so matrix changes apply without re-login.
    req.user = { ...payload, permissions: permissionsForRole(payload.role, payload.permissions ?? []) };
  } catch {
    return next(new UnauthorizedError('Invalid or expired access token'));
  }

  const organizationId = req.user.organizationId;
  connectionForOrganization(organizationId)
    .then((connection) => tenantStorage.run({ organizationId, connection }, () => next()))
    .catch(next);
}

export function authorize(...permissions: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());

    const allowed = permissions.some((p) => hasPermission(req.user!, p));
    if (!allowed) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    next();
  };
}

export function authorizeRoles(...roles: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Role not authorized'));
    }
    next();
  };
}
