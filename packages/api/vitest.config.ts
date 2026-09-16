import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres database. Running files in parallel
    // would let one file's TRUNCATE wipe another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // ADR-003's reconciliation window is 30s in production. The tests assert
    // which outcome is reached, not how long it takes, so a short window keeps
    // the suite quick without weakening what it proves.
    env: {
      PAYMENT_POLL_INTERVAL_MS: '200',
      PAYMENT_POLL_TIMEOUT_MS: '3000',
    },
  },
});
