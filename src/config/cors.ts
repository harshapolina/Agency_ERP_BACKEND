import type { CorsOptions } from 'cors';

/** Always allowed — merged with CORS_ORIGIN env (comma-separated). */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://dashboards.editcomedia.com',
  'https://dashboards-frontend.vercel.app',
  'https://agency-erp-frontend.vercel.app',
];

/** Parse comma-separated CORS_ORIGIN env value into a list of allowed origins. */
export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function getAllowedOrigins(corsOriginEnv: string): string[] {
  return [...new Set([...DEFAULT_CORS_ORIGINS, ...parseCorsOrigins(corsOriginEnv)])];
}

/** Vercel preview URLs for the frontend projects */
function isVercelPreviewOrigin(origin: string): boolean {
  return (
    /^https:\/\/dashboards-frontend[a-z0-9-]*\.vercel\.app$/i.test(origin) ||
    /^https:\/\/agency-erp-frontend[a-z0-9-]*\.vercel\.app$/i.test(origin)
  );
}

export function createCorsOptions(corsOriginEnv: string): CorsOptions {
  const origins = new Set(getAllowedOrigins(corsOriginEnv));

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/$/, '');
      if (origins.has(normalized) || isVercelPreviewOrigin(normalized)) {
        callback(null, normalized);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };
}
