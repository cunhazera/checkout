import { randomUUID } from 'node:crypto';
import { pool, withTransaction, type Db } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest, orderNotFound, totemNotFound } from '../errors.js';
import { addCents, cents, multiplyCents, sumCents, taxOn, type Cents } from '../money.js';
import { reserveStock, releaseReservations, type RequestedLine } from './stock.service.js';
import { getStore } from './store.service.js';

export type OrderStatus = 'pending' | 'confirmed' | 'paid' | 'failed' | 'cancelled' | 'expired';

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
}

export interface Order {
  id: string;
  storeId: string;
  totemId: string;
  sessionId: string;
  status: OrderStatus;
  /** ISO 4217. Every *Cents field on this order is in this currency. */
  currency: string;
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  expiresAt: string;
  createdAt: string;
  items: OrderLine[];
}

export interface CreateOrderInput {
  sessionId: string;
  totemId: string;
  items: readonly RequestedLine[];
}

export interface StartedSession {
  sessionId: string;
  storeId: string;
  expiresAt: string;
}

/**
 * Arch doc: no database write here. The session materialises only when an order
 * is created — that is what keeps ADR-002's "no user entity" honest.
 */
export function startSession(storeId: string): StartedSession {
  return {
    sessionId: randomUUID(),
    storeId,
    expiresAt: new Date(Date.now() + config.orderTtlMinutes * 60_000).toISOString(),
  };
}

/**
 * The HTTP layer validates shape with JSON Schema before this runs. These checks
 * stay because services are also called directly (tests, jobs), and because
 * duplicate item ids cannot be expressed in JSON Schema.
 */
function validateInput(input: CreateOrderInput): void {
  if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) {
    throw badRequest('sessionId is required');
  }
  if (typeof input.totemId !== 'string' || input.totemId.length === 0) {
    throw badRequest('totemId is required');
  }
  const lines = input.items;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw badRequest('An order must contain at least one item');
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line?.productId !== 'string' || line.productId.length === 0) {
      throw badRequest('Each line must carry a productId');
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw badRequest('Each line quantity must be a positive integer', {
        productId: line.productId,
      });
    }
    if (seen.has(line.productId)) {
      // Two lines for the same product would take the same lock twice and
      // double the reservation. The client merges them into one quantity.
      throw badRequest('Duplicate productId in order', { productId: line.productId });
    }
    seen.add(line.productId);
  }
}

export async function createOrder(storeId: string, input: CreateOrderInput): Promise<Order> {
  validateInput(input);
  // Currency and tax rate belong to the store, not to global configuration.
  const store = await getStore(storeId);

  const order = await withTransaction(async (db) => {
    // The composite foreign key (store_id, totem_id) would reject a foreign
    // totem too, but as a raw constraint error. Check first for a clean 400.
    const { rowCount } = await db.query(
      `SELECT 1 FROM totems WHERE store_id = $1 AND id = $2 AND active`,
      [storeId, input.totemId],
    );
    if (rowCount === 0) throw totemNotFound(input.totemId);

    const priced = await reserveStock(db, storeId, input.items);

    const subtotal = sumCents(priced.map((p) => multiplyCents(p.unitPriceCents, p.quantity)));
    const tax = taxOn(subtotal, store.taxBasisPoints);
    const total = addCents(subtotal, tax);

    // Processors reject zero-amount charges, so an order that costs nothing
    // would fail at the gateway with a confusing error. Revisit if free items
    // (a promotion, a loyalty reward) ever become a thing.
    if (total <= 0) throw badRequest('An order must cost something', { totalCents: total });

    const { rows } = await db.query<{ id: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO orders (store_id, totem_id, session_id, status, currency,
                           subtotal_cents, tax_cents, total_cents, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, NOW() + ($8 || ' minutes')::interval)
       RETURNING id, created_at, expires_at`,
      [
        storeId,
        input.totemId,
        input.sessionId,
        store.currency,
        subtotal,
        tax,
        total,
        String(config.orderTtlMinutes),
      ],
    );
    const created = rows[0]!;

    for (const line of priced) {
      await db.query(
        `INSERT INTO order_items (store_id, order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [storeId, created.id, line.productId, line.quantity, line.unitPriceCents],
      );
    }

    return {
      id: created.id,
      storeId,
      totemId: input.totemId,
      sessionId: input.sessionId,
      status: 'pending' as const,
      currency: store.currency,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: total,
      createdAt: created.created_at.toISOString(),
      expiresAt: created.expires_at.toISOString(),
      items: priced.map((p) => ({
        productId: p.productId,
        name: p.name,
        quantity: p.quantity,
        unitPriceCents: p.unitPriceCents,
        lineTotalCents: multiplyCents(p.unitPriceCents, p.quantity),
      })),
    };
  });

  return order;
}

/**
 * Always addressed by (store, order). An order id from another store is simply
 * not found — a totem can never read a different store's orders by guessing ids.
 */
export async function getOrder(
  storeId: string,
  orderId: string,
  db: Db | typeof pool = pool,
): Promise<Order> {
  const { rows } = await db.query<{
    id: string;
    store_id: string;
    totem_id: string;
    session_id: string;
    status: OrderStatus;
    currency: string;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT o.id, o.store_id, o.totem_id, o.session_id, o.status, o.currency,
            o.subtotal_cents, o.tax_cents, o.total_cents, o.created_at, o.expires_at
       FROM orders o
      WHERE o.store_id = $1 AND o.id = $2`,
    [storeId, orderId],
  );
  const row = rows[0];
  if (!row) throw orderNotFound(orderId);

  const { rows: itemRows } = await db.query<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price_cents: number;
  }>(
    `SELECT oi.product_id, p.name, oi.quantity, oi.unit_price_cents
       FROM order_items oi
       JOIN products p ON p.store_id = oi.store_id AND p.id = oi.product_id
      WHERE oi.store_id = $1 AND oi.order_id = $2
      ORDER BY p.name`,
    [storeId, orderId],
  );

  return {
    id: row.id,
    storeId: row.store_id,
    totemId: row.totem_id,
    sessionId: row.session_id,
    status: row.status,
    currency: row.currency,
    subtotalCents: cents(row.subtotal_cents),
    taxCents: cents(row.tax_cents),
    totalCents: cents(row.total_cents),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    items: itemRows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      quantity: r.quantity,
      unitPriceCents: cents(r.unit_price_cents),
      lineTotalCents: multiplyCents(cents(r.unit_price_cents), r.quantity),
    })),
  };
}

/**
 * Totem inactivity / "Cancel order". Releases stock and closes the order.
 * Idempotent: cancelling an already-closed order is a no-op, not an error —
 * the totem may fire this after the expiry job has already reaped it.
 *
 * Orders are never deleted; they are financial records. That is why the API
 * exposes this as POST .../cancel rather than DELETE.
 */
export async function cancelOrder(storeId: string, orderId: string): Promise<{ status: OrderStatus }> {
  const status = await withTransaction(async (db) => {
    const { rows } = await db.query<{ status: OrderStatus }>(
      `SELECT status FROM orders WHERE store_id = $1 AND id = $2 FOR UPDATE`,
      [storeId, orderId],
    );
    const row = rows[0];
    if (!row) throw orderNotFound(orderId);
    if (row.status !== 'pending') return row.status;

    await releaseReservations(db, storeId, orderId);
    await db.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE store_id = $1 AND id = $2`,
      [storeId, orderId],
    );
    return 'cancelled' as const;
  });

  return { status };
}
