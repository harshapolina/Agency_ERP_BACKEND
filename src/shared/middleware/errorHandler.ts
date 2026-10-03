import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/index.js';
import { logger } from '../logger/index.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        code: err.code,
        details: err.details,
      },
    });
  }

  if (err.name === 'ValidationError' && 'errors' in err) {
    const first = Object.values((err as unknown as { errors: Record<string, { message: string }> }).errors)[0];
    return res.status(400).json({
      success: false,
      error: { message: first?.message || 'Validation failed', code: 'VALIDATION_ERROR' },
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, error: { message: 'Invalid identifier or value', code: 'INVALID_VALUE' } });
  }

  if ((err as { code?: number }).code === 11000) {
    const key = Object.keys((err as unknown as { keyValue?: Record<string, unknown> }).keyValue || {}).filter((k) => k !== 'organizationId');
    return res.status(409).json({
      success: false,
      error: { message: key.length ? `A record with this ${key.join(', ')} already exists` : 'Duplicate record', code: 'CONFLICT' },
    });
  }

  const isDbError =
    err.name === 'MongoServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    err.name === 'MongooseError' ||
    err.name === 'MongoParseError' ||
    err.message?.includes('MongoDB connection failed') ||
    err.message?.includes('buffering timed out') ||
    err.message?.includes('bad auth') ||
    err.message?.includes('Authentication failed');

  if (isDbError) {
    logger.error('Database error', { error: err.message, name: err.name });
    return res.status(503).json({
      success: false,
      error: {
        message: 'Database unavailable. Check MONGODB_URI (no quotes), Atlas user password, and Network Access 0.0.0.0/0, then redeploy.',
        code: 'DATABASE_UNAVAILABLE',
      },
    });
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack });

  return res.status(500).json({
    success: false,
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { message: 'Route not found', code: 'ROUTE_NOT_FOUND' },
  });
}
