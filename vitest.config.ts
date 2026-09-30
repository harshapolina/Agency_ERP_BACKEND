import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // Each file boots its own app against its own database, so files are safe to run in parallel.
    pool: 'threads',
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MONGODB_URI: 'mongodb://placeholder',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0001',
      JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-01',
      DATA_ENCRYPTION_KEY: 'test-data-encryption-key',
      CRON_SECRET: 'test-cron-secret',
      BCRYPT_ROUNDS: '4',
      SMTP_USER: '',
      SMTP_PASS: '',
    },
  },
});
