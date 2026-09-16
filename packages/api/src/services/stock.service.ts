import type { Db } from '../db/pool.js';
import { outOfStock, itemUnavailable } from '../errors.js';
import { cents, type Cents } from '../money.js';

export interface RequestedLine {
  itemId: string;
  quantity: number;
}

export interface PricedLine extends RequestedLine {
  name: string;
  unitPriceCents: Cents;
}

/**
 * ADR-004: pessimistic locking. Locks every requested item's stock row in one
 * store, verifies availability, and increments `reserved`. Must run inside a
 * transaction — the caller's rollback is what releases the locks on failure.
 *
 * Every lock taken here belongs to a single store, so two stores never contend
 * and a transaction never spans stores. That property is what lets stores be
 * split across database shards later without distributed transactions.
 *
 * Lock ordering: item ids are sorted before locking. Two carts holding
 * overlapping items in opposite order would otherwise deadlock.
 */
export async function reserveStock(
  db: Db,
  storeId: string,
  lines: readonly RequestedLine[],
): Promise<PricedLine[]> {
  const ordered = [...lines].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const priced: PricedLine[] = [];

  for (const line of ordered) {
    // Lock the stock row and read the price snapshot in one shot. The price is
    // this store's price, read inside the transaction: it is what order_items
    // records. An item the store does not sell has no row and is unavailable.
    const { rows } = await db.query<{
      item_id: string;
      quantity: number;
      reserved: number;
      name: string;
      price_cents: number;
      active: boolean;
    }>(
      `SELECT s.item_id, s.quantity, s.reserved, i.name, si.price_cents,
              (si.active AND i.active) AS active
         FROM stock s
         JOIN store_items si ON si.store_id = s.store_id AND si.item_id = s.item_id
         JOIN items i ON i.id = s.item_id
        WHERE s.store_id = $1
          AND s.item_id = $2
          FOR UPDATE OF s`,
      [storeId, line.itemId],
    );

    const row = rows[0];
    if (!row || !row.active) throw itemUnavailable(line.itemId);

    const available = row.quantity - row.reserved;
    if (available < line.quantity) {
      // Throwing rolls the caller's transaction back, releasing every
      // reservation made so far in this call. No partial reservation survives.
      throw outOfStock(row.item_id, row.name, available);
    }

    await db.query(
      `UPDATE stock
          SET reserved = reserved + $3, updated_at = NOW()
        WHERE store_id = $1 AND item_id = $2`,
      [storeId, line.itemId, line.quantity],
    );

    priced.push({
      itemId: row.item_id,
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
        AND s.item_id = oi.item_id`,
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
        AND s.item_id = oi.item_id`,
    [storeId, orderId],
  );
}
