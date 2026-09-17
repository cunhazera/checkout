import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closePool } from '../src/db/pool.js';
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
beforeEach(resetDatabase);
afterAll(closePool);

/**
 * These are the tests that justify ADR-004. If pessimistic locking is ever
 * swapped for optimistic, or the lock ordering is removed, these fail.
 */
describe('concurrent stock reservation (ADR-004)', () => {
  it('never oversells the last unit', async () => {
    // `water` is seeded with quantity 1.
    const totems = await registerTotems(8);
    const attempts = totems.map((totem) =>
      placeOrder([{ productId: PRODUCT.water, quantity: 1 }], { totem }),
    );
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'product_out_of_stock' });
    }

    const stock = await getStock(PRODUCT.water);
    expect(stock.reserved).toBe(1);
    expect(stock.quantity).toBe(1);
    await assertStockInvariant();
  });

  it('reserves exactly the available amount under contention', async () => {
    await setStock(PRODUCT.sandwich, 5);

    // Ten carts each want 1; only 5 can succeed.
    const totems = await registerTotems(10);
    const results = await Promise.allSettled(
      totems.map((totem) => placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }], { totem })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect((await getStock(PRODUCT.sandwich)).reserved).toBe(5);
    await assertStockInvariant();
  });

  it('does not deadlock when carts request overlapping items in opposite order', async () => {
    await setStock(PRODUCT.chips, 50);
    await setStock(PRODUCT.cola, 50);

    // Without sorted lock acquisition in reserveStock, these two orderings
    // form a cycle: A holds chips and waits for cola while B holds cola and
    // waits for chips.
    //
    // Under SERIALIZABLE the retry wrapper eventually pushes every one of these
    // through, so success alone no longer proves the ordering is right — it
    // only proves the retries are papering over it. What it costs is the real
    // signal: Postgres waits out `deadlock_timeout` (1s by default) before it
    // will even look for a cycle, so each victim burns a full second.
    //
    // Measured on this suite: ~250ms with sorted locks, ~8.4s without.
    const started = Date.now();
    const totems = await registerTotems(12);
    const results = await Promise.allSettled(
      totems.map((totem, i) =>
        i % 2 === 0
          ? placeOrder(
              [
                { productId: PRODUCT.chips, quantity: 1 },
                { productId: PRODUCT.cola, quantity: 1 },
              ],
              { totem },
            )
          : placeOrder(
              [
                { productId: PRODUCT.cola, quantity: 1 },
                { productId: PRODUCT.chips, quantity: 1 },
              ],
              { totem },
            ),
      ),
    );
    const elapsed = Date.now() - started;

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect((await getStock(PRODUCT.chips)).reserved).toBe(12);
    expect((await getStock(PRODUCT.cola)).reserved).toBe(12);

    // The guard: comfortably above the healthy ~250ms, far below the ~8.4s that
    // deadlock detection costs.
    expect(elapsed).toBeLessThan(3_000);
    await assertStockInvariant();
  });
});
