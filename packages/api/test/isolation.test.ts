import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closePool,
  withTransaction,
  getTransactionRetryCount,
  resetTransactionRetryCount,
} from '../src/db/pool.js';
import {
  PRODUCT,
  STORE,
  assertStockInvariant,
  getStock,
  placeOrder,
  registerTotems,
  resetDatabase,
  setStock,
  setupDatabase,
} from './helpers.js';

beforeAll(setupDatabase);
beforeEach(async () => {
  await resetDatabase();
  resetTransactionRetryCount();
});
afterAll(closePool);

describe('transaction isolation', () => {
  it('runs every transaction as SERIALIZABLE', async () => {
    const level = await withTransaction(async (db) => {
      const { rows } = await db.query<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
      );
      return rows[0]!.transaction_isolation;
    });
    expect(level).toBe('serializable');
  });

  it('rolls back cleanly and does not retry a business-logic failure', async () => {
    resetTransactionRetryCount();
    await expect(
      placeOrder([{ productId: PRODUCT.coffee, quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'product_out_of_stock' });

    // A 409 is a real answer, not contention — replaying it would be pointless.
    expect(getTransactionRetryCount()).toBe(0);
    expect((await getStock(PRODUCT.coffee)).reserved).toBe(0);
  });

  it('replays a serialization failure instead of surfacing it', async () => {
    let attempts = 0;
    const result = await withTransaction(async (db) => {
      attempts += 1;
      await db.query('SELECT 1');
      if (attempts < 3) {
        // What Postgres raises when it cannot order two transactions.
        const err = new Error('could not serialize access due to read/write dependencies');
        (err as Error & { code: string }).code = '40001';
        throw err;
      }
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(getTransactionRetryCount()).toBe(2);
  });

  it('gives up after the retry budget and surfaces it as retryable', async () => {
    let attempts = 0;
    await expect(
      withTransaction(
        async (db) => {
          attempts += 1;
          await db.query('SELECT 1');
          const err = new Error('could not serialize access');
          (err as Error & { code: string }).code = '40001';
          throw err;
        },
        { retries: 2 },
      ),
      // Contention is transient, so it reaches the totem as "busy, try again"
      // rather than a raw Postgres error code.
    ).rejects.toMatchObject({ statusCode: 503, code: 'database_busy' });

    expect(attempts).toBe(3); // the initial attempt plus two replays
  });

  it('still never oversells under SERIALIZABLE', async () => {
    await setStock(PRODUCT.sandwich, 3);

    const totems = await registerTotems(12);
    const results = await Promise.allSettled(
      totems.map((totem) => placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }], { totem })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await getStock(PRODUCT.sandwich)).reserved).toBe(3);
    await assertStockInvariant();
  });
});
