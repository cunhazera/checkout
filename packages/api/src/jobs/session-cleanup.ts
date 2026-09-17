import { pool, withTransaction } from '../db/pool.js';
import { releaseReservations } from '../services/stock.service.js';

/**
 * Arch doc: runs every 60 seconds, returning stock held by orders that were
 * never paid for.
 *
 * Each order is handled in its own transaction and re-checked under a row lock.
 * Without that re-check the reaper could race an in-flight payment and release
 * stock for an order that is being paid for in the same instant.
 */
export async function runSessionCleanup(
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  // Deliberately not store-scoped: one sweep covers every store, using
  // idx_orders_expiry. Once stores are split across shards, this runs once per
  // shard. Everything after the scan is addressed by (store, order).
  const { rows } = await pool.query<{ store_id: string; id: string }>(
    `SELECT store_id, id FROM orders WHERE status = 'pending' AND expires_at < NOW()`,
  );

  const expired: string[] = [];

  for (const { store_id: storeId, id } of rows) {
    const didExpire = await withTransaction(async (db) => {
      const { rows: locked } = await db.query<{ status: string; expired: boolean }>(
        `SELECT status, (expires_at < NOW()) AS expired
           FROM orders WHERE store_id = $1 AND id = $2 FOR UPDATE`,
        [storeId, id],
      );
      const order = locked[0];
      // Status may have moved to paid/failed between the scan and the lock.
      if (!order || order.status !== 'pending' || !order.expired) return false;

      await releaseReservations(db, storeId, id);
      await db.query(
        `UPDATE orders SET status = 'expired', updated_at = NOW() WHERE store_id = $1 AND id = $2`,
        [storeId, id],
      );
      return true;
    });

    if (didExpire) {
      expired.push(id);
      // This job silently returning stock is the thing most likely to hide a
      // bug, so every release is logged.
      log(`expired order ${id} at store ${storeId}, reservations released`);
    }
  }

  return expired;
}

export interface CleanupHandle {
  /** Stops the timer and waits for a sweep already in progress to finish. */
  stop(): Promise<void>;
}

/**
 * A plain interval rather than a cron dependency — the cadence is a fixed 60
 * seconds, so cron expressions would only add a package and a parser.
 * `unref()` keeps the timer from holding the process open during shutdown.
 */
export function startSessionCleanup(
  log?: (msg: string) => void,
  intervalMs = 60_000,
): CleanupHandle {
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    // A slow sweep must not overlap itself and double-release stock.
    if (inFlight) return;
    inFlight = runSessionCleanup(log)
      .then(() => undefined)
      .catch((err) => console.error('session cleanup failed', err))
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);

  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      // Closing the pool under a sweep that is mid-transaction would fail it
      // halfway through an order. Let it finish first.
      await inFlight;
    },
  };
}
