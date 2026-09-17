import type { Db } from '../db/pool.js';
import { outOfStock, productUnavailable } from '../errors.js';
import { cents, type Cents } from '../money.js';

export interface RequestedLine {
  productId: string;
  quantity: number;
}

export interface PricedLine extends RequestedLine {
  name: string;
  unitPriceCents: Cents;
}

/**
 * ADR-004: pessimistic locking. Locks every requested product's stock row in one
 * store, verifies availability, and increments `reserved`. Must run inside a
 * transaction — the caller's rollback is what releases the locks on failure.
 *
 * Every lock taken here belongs to a single store, so two stores never contend
 * and a transaction never spans stores. That property is what lets stores be
 * split across database shards later without distributed transactions.
 *
 * Lock ordering: product ids are sorted before locking. Two carts holding
 * overlapping products in opposite order would otherwise deadlock.
 */
export async function reserveStock(
  db: Db,
  storeId: string,
  lines: readonly RequestedLine[],
): Promise<PricedLine[]> {
  const ordered = [...lines].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );

  const priced: PricedLine[] = [];

  for (const line of ordered) {
    // Lock the stock row and read the price in one shot. The price is read
    // inside the transaction because it is what order_items records. A product
    // this store does not sell has no row here at all.
    const { rows } = await db.query<{
      product_id: string;
      quantity: number;
      reserved: number;
      name: string;
      price_cents: number;
      active: boolean;
    }>(
      `SELECT s.product_id, s.quantity, s.reserved, p.name, p.price_cents, p.active
         FROM stock s
         JOIN products p ON p.store_id = s.store_id AND p.id = s.product_id
        WHERE s.store_id = $1
          AND s.product_id = $2
          FOR UPDATE OF s`,
      [storeId, line.productId],
    );

    const row = rows[0];
    if (!row || !row.active) throw productUnavailable(line.productId);

    const available = row.quantity - row.reserved;
    if (available < line.quantity) {
      // Throwing rolls the caller's transaction back, releasing every
      // reservation made so far in this call. No partial reservation survives.
      throw outOfStock(row.product_id, row.name, available);
    }

    await db.query(
      `UPDATE stock
          SET reserved = reserved + $3, updated_at = NOW()
        WHERE store_id = $1 AND product_id = $2`,
      [storeId, line.productId, line.quantity],
    );

    priced.push({
      productId: row.product_id,
      quantity: line.quantity,
      name: row.name,
      unitPriceCents: cents(row.price_cents),
    });
  }

  return priced;
}

/**
 * Releases held reservations without touching the physical count. Used on
 * payment failure, order cancellation and session expiry.
 */
export async function releaseReservations(db: Db, storeId: string, orderId: string): Promise<void> {
  await db.query(
    `UPDATE stock s
        SET reserved = s.reserved - oi.quantity, updated_at = NOW()
       FROM order_items oi
      WHERE oi.store_id = $1
        AND oi.order_id = $2
        AND s.store_id = oi.store_id
        AND s.product_id = oi.product_id`,
    [storeId, orderId],
  );
}

/**
 * ADR-004: the physical decrement. Happens only on confirmed payment — this is
 * the single place `quantity` ever goes down.
 */
export async function commitReservations(db: Db, storeId: string, orderId: string): Promise<void> {
  await db.query(
    `UPDATE stock s
        SET quantity = s.quantity - oi.quantity,
            reserved = s.reserved - oi.quantity,
            updated_at = NOW()
       FROM order_items oi
      WHERE oi.store_id = $1
        AND oi.order_id = $2
        AND s.store_id = oi.store_id
        AND s.product_id = oi.product_id`,
    [storeId, orderId],
  );
}
