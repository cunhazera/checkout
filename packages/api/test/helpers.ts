import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { invalidateMenuCache } from '../src/services/menu.service.js';
import { invalidateStoreCache } from '../src/services/store.service.js';
import { createOrder } from '../src/services/order.service.js';
import type { RequestedLine } from '../src/services/stock.service.js';

/** Seeded stores. `main` keeps the original single-store data and prices. */
export const STORE = {
  main: 'a0000000-0000-4000-8000-000000000001', // LOCAL-0001, USD
  br: 'a0000000-0000-4000-8000-000000000002', // BR-SP-0001, BRL, no Iced coffee
} as const;

/** Seeded totems, five per store. */
export const TOTEM = {
  main: 'b0000000-0000-4000-8000-000000000001', // LOCAL-0001 / T1
  main2: 'b0000000-0000-4000-8000-000000000002', // LOCAL-0001 / T2
  br: 'b0000000-0000-4000-8000-000000000011', // BR-SP-0001 / T1
} as const;

export const ITEM = {
  chips: '11111111-1111-4111-8111-000000000001',
  almonds: '11111111-1111-4111-8111-000000000002',
  bar: '11111111-1111-4111-8111-000000000003',
  cookies: '11111111-1111-4111-8111-000000000004',
  sandwich: '11111111-1111-4111-8111-000000000005',
  fruit: '11111111-1111-4111-8111-000000000006',
  water: '11111111-1111-4111-8111-000000000007', // seeded with quantity 1
  cola: '11111111-1111-4111-8111-000000000008',
  coffee: '11111111-1111-4111-8111-000000000009', // seeded with quantity 0
} as const;

export async function setupDatabase(): Promise<void> {
  await migrate(() => {});
}

/** Full reset between tests. Concurrency tests need real committed state, so
 *  this re-seeds rather than wrapping tests in a rollback. */
export async function resetDatabase(): Promise<void> {
  await seed();
  invalidateMenuCache();
  invalidateStoreCache();
}

/** Creates an order the way a totem does: fresh session, a registered totem. */
export function placeOrder(
  items: readonly RequestedLine[],
  { store = STORE.main, totem = TOTEM.main }: { store?: string; totem?: string } = {},
) {
  return createOrder(store, { sessionId: randomUUID(), totemId: totem, items });
}

export async function setStock(
  itemId: string,
  quantity: number,
  reserved = 0,
  store: string = STORE.main,
): Promise<void> {
  await pool.query(
    'UPDATE stock SET quantity = $3, reserved = $4 WHERE store_id = $1 AND item_id = $2',
    [store, itemId, quantity, reserved],
  );
  invalidateMenuCache();
}

export async function getStock(
  itemId: string,
  store: string = STORE.main,
): Promise<{ quantity: number; reserved: number }> {
  const { rows } = await pool.query<{ quantity: number; reserved: number }>(
    'SELECT quantity, reserved FROM stock WHERE store_id = $1 AND item_id = $2',
    [store, itemId],
  );
  return rows[0]!;
}

export async function getOrderStatus(orderId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM orders WHERE id = $1',
    [orderId],
  );
  return rows[0]!.status;
}

export async function expireOrder(orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
    orderId,
  ]);
}

/**
 * The ADR-004 invariant. Two separate claims:
 *   1. reserved is never negative and never exceeds quantity, and
 *   2. reserved equals the stock actually held by live orders.
 *
 * The earlier version computed `expected` but never compared against it, so
 * claim 2 was never really asserted. 'confirmed' counts as live — an order
 * mid-payment still holds its reservation.
 *
 * Checked per (store, item) across every store at once: a reservation leaking
 * from one store into another would show up here.
 */
export async function assertStockInvariant(): Promise<void> {
  const { rows } = await pool.query<{ item_id: string; reserved: number; expected: number }>(
    `SELECT s.store_id, s.item_id, s.reserved, COALESCE(h.held, 0)::int AS expected
       FROM stock s
       LEFT JOIN (
         SELECT oi.store_id, oi.item_id, SUM(oi.quantity) AS held
           FROM order_items oi
           JOIN orders o ON o.store_id = oi.store_id AND o.id = oi.order_id
          WHERE o.status IN ('pending', 'confirmed')
          GROUP BY oi.store_id, oi.item_id
       ) h ON h.store_id = s.store_id AND h.item_id = s.item_id
      WHERE s.reserved < 0
         OR s.quantity < s.reserved
         OR s.reserved <> COALESCE(h.held, 0)`,
  );
  if (rows.length > 0) {
    throw new Error(`stock invariant violated: ${JSON.stringify(rows)}`);
  }
}
