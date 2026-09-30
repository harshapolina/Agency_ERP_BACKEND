import { once } from 'events';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { expect, inject } from 'vitest';

export const CREDS = {
  super: { email: 'super@test.local', password: 'Super#Test1234' },
  admin: { email: 'admin@test.local', password: 'Admin#Test1234' },
  sales: { email: 'sales@test.local', password: 'Sales#Test1234' },
};
export const ORG_SLUG = 'editco-media';

export interface ApiResponse<T = any> {
  status: number;
  body: any;
  data: T;
}

export class Api {
  constructor(readonly base: string, readonly token = '') {}

  as(token: string) {
    return new Api(this.base, token);
  }

  anon() {
    return new Api(this.base);
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token && { authorization: `Bearer ${this.token}` }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json?.data };
  }

  get<T = any>(path: string, headers?: Record<string, string>) { return this.request<T>('GET', path, undefined, headers); }
  post<T = any>(path: string, body: unknown = {}) { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }
  put<T = any>(path: string, body: unknown) { return this.request<T>('PUT', path, body); }
  delete<T = any>(path: string) { return this.request<T>('DELETE', path); }

  /** Asserts a 2xx and returns `data`, printing the API error when it isn't. */
  async ok<T = any>(p: Promise<ApiResponse<T>>): Promise<T> {
    const r = await p;
    expect(r.status, `${JSON.stringify(r.body?.error ?? r.body)}`).toBeLessThan(400);
    return r.data;
  }

  async login(who: keyof typeof CREDS) {
    const path = who === 'super' ? '/auth/admin/login' : '/auth/login';
    const data = await this.ok(this.anon().post<{ accessToken: string }>(path, CREDS[who]));
    return this.as(data.accessToken);
  }
}

export interface TestApp {
  api: Api;
  mongoUri: string;
  dbName: string;
  close: () => Promise<void>;
}

/** Boots the Express app on a random port against a fresh, seeded database. */
export async function startApp(): Promise<TestApp> {
  const mongoUri = inject('mongoUri').replace(/\/$/, '');
  const dbName = `t_${randomUUID().slice(0, 12)}`;
  process.env.MONGODB_URI = `${mongoUri}/${dbName}`;
  process.env.SEED_SUPER_ADMIN_EMAIL = CREDS.super.email;
  process.env.SEED_SUPER_ADMIN_PASSWORD = CREDS.super.password;
  process.env.SEED_ADMIN_EMAIL = CREDS.admin.email;
  process.env.SEED_ADMIN_PASSWORD = CREDS.admin.password;
  process.env.SEED_SALES_EMAIL = CREDS.sales.email;
  process.env.SEED_SALES_PASSWORD = CREDS.sales.password;

  const [{ default: app }, db, { seedDatabase }, mongoose] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/database.js'),
    import('../src/scripts/seed-core.js'),
    import('mongoose'),
  ]);
  // Building ~70 collections' indexes per test database dominates run time; no test relies on them.
  mongoose.default.set('autoIndex', false);
  mongoose.default.set('autoCreate', false);
  await db.connectDatabase();
  await seedDatabase({ demo: true, quiet: true });

  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    api: new Api(`http://127.0.0.1:${port}/api/v1`),
    mongoUri,
    dbName,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await mongoose.default.connection.dropDatabase().catch(() => undefined);
      await db.disconnectDatabase();
    },
  };
}

export const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
