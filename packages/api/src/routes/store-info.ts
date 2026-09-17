import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { storeParams } from './schemas.js';

export async function storeInfoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What a totem needs to render money and tax for its store. Replaces the old
   * global GET /config: currency, locale and tax differ by store now.
   */
  app.get('/', { schema: { params: storeParams } }, async (req) => {
    const { id, code, name, countryCode, timezone, currency, locale, taxBasisPoints } = req.store;
    return { id, code, name, countryCode, timezone, currency, locale, taxBasisPoints };
  });

  /**
   * The ADR-004 invariant for one store: `reserved` must never be negative or
   * exceed `quantity`, and must equal the stock held by this store's live
   * orders. A non-empty `drifted` list means stock accounting has gone wrong.
   *
   * Store-scoped on purpose: a national invariant check would be a full-table
   * aggregate, and after sharding it could not run in one query anyway.
   */
  app.get('/health/stock', { schema: { params: storeParams } }, async (req) => {
    const { rows } = await pool.query<{ product_id: string; reserved: number; expected: number }>(
      `SELECT s.product_id, s.reserved, COALESCE(h.held, 0)::int AS expected
         FROM stock s
         LEFT JOIN (
           SELECT oi.product_id, SUM(oi.quantity) AS held
             FROM orders o
             JOIN order_items oi ON oi.store_id = o.store_id AND oi.order_id = o.id
            WHERE o.store_id = $1
              AND o.status IN ('pending', 'confirmed')
            GROUP BY oi.product_id
         ) h ON h.product_id = s.product_id
        WHERE s.store_id = $1`,
      [req.store.id],
    );
    const drifted = rows.filter((r) => r.reserved !== r.expected);
    return { ok: drifted.length === 0, drifted };
  });

  /**
   * This store's orders stuck in 'confirmed': payment was in flight and never
   * resolved. They hold stock, and the expiry reaper skips them on purpose.
   * Only a human reconciling with the processor can close one out.
   */
  app.get('/health/orders', { schema: { params: storeParams } }, async (req) => {
    const { rows } = await pool.query<{
      id: string;
      total_cents: number;
      updated_at: Date;
      payment_status: string | null;
    }>(
      `SELECT o.id, o.total_cents, o.updated_at,
              (SELECT p.status FROM payments p
                WHERE p.store_id = o.store_id AND p.order_id = o.id
                ORDER BY p.created_at DESC LIMIT 1) AS payment_status
         FROM orders o
        WHERE o.store_id = $1
          AND o.status = 'confirmed'
        ORDER BY o.updated_at`,
      [req.store.id],
    );
    // Charges the gateway accepted for an order that did not end up paid: the
    // customer was charged and the goods were not released, so someone has to
    // refund. The resolver cannot fix these; it can only stop creating them.
    const { rows: mismatched } = await pool.query<{
      id: string;
      order_status: string;
      total_cents: number;
    }>(
      `SELECT o.id, o.status AS order_status, o.total_cents
         FROM payments p
         JOIN orders o ON o.store_id = p.store_id AND o.id = p.order_id
        WHERE p.store_id = $1
          AND p.status = 'succeeded'
          AND o.status <> 'paid'
        ORDER BY o.updated_at`,
      [req.store.id],
    );

    return {
      ok: rows.length === 0 && mismatched.length === 0,
      chargedButNotPaid: mismatched.map((m) => ({
        orderId: m.id,
        orderStatus: m.order_status,
        totalCents: m.total_cents,
      })),
      needsReconciliation: rows.map((r) => ({
        orderId: r.id,
        totalCents: r.total_cents,
        paymentStatus: r.payment_status,
        since: r.updated_at.toISOString(),
      })),
    };
  });
}
