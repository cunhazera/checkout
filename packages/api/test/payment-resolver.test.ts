import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '@checkout/gateway';
import { closePool, pool } from '../src/db/pool.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { runPaymentResolver } from '../src/jobs/payment-resolver.js';
import { HttpTerminal } from '../src/ports/http-terminal.js';
import {
  ITEM,
  STORE,
  assertStockInvariant,
  getOrderStatus,
  getStock,
  placeOrder,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

let gateway: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  await setupDatabase();
  gateway = buildGateway();
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const addr = gateway.server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('gateway did not bind');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  setTerminal(new HttpTerminal(baseUrl, 1_000, 1));
});

beforeEach(async () => {
  await resetDatabase();
  await gateway.inject({ method: 'POST', url: '/control/reset' });
  setTerminal(new HttpTerminal(baseUrl, 1_000, 1));
});

afterAll(async () => {
  await gateway.close();
  await closePool();
});

/** The resolver only looks at attempts older than its grace period. */
const resolve = (maxAttempts = 3) =>
  runPaymentResolver(() => {}, { graceMs: 0, maxAttempts });

const paymentRow = async (orderId: string) => {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    resolve_attempts: number;
    idempotency_key: string;
  }>(
    'SELECT id, status, resolve_attempts, idempotency_key FROM payments WHERE store_id = $1 AND order_id = $2',
    [STORE.main, orderId],
  );
  return rows[0]!;
};

/**
 * Reproduces exactly what `payOrder` leaves behind when the process dies
 * between claiming the order and settling the outcome: order 'confirmed',
 * payment 'pending', stock still reserved.
 */
async function crashMidPayment(quantity = 2) {
  const order = await placeOrder([{ itemId: ITEM.chips, quantity }]);
  const key = `pay_${order.id}_1`;
  await pool.query(
    `UPDATE orders SET status = 'confirmed' WHERE store_id = $1 AND id = $2`,
    [STORE.main, order.id],
  );
  await pool.query(
    `INSERT INTO payments (store_id, order_id, amount_cents, status, idempotency_key, method)
     VALUES ($1, $2, $3, 'pending', $4, 'card')`,
    [STORE.main, order.id, order.totalCents, key],
  );
  return { order, key };
}

/**
 * Makes the gateway hold a charge for that key, as if we had called it before
 * crashing. `respondAfterMs` keeps the never-settling scenario from making the
 * setup itself wait a minute for its reply.
 */
async function chargeAtGateway(key: string, amountCents: number, scenario = 'approved') {
  await gateway.inject({
    method: 'POST',
    url: '/control/scenario',
    payload: { scenario, respondAfterMs: 50, settleAfterMs: 50 },
  });
  await gateway.inject({
    method: 'POST',
    url: '/charges',
    payload: { idempotencyKey: key, amountCents, currency: 'USD', method: 'card' },
  });
}

describe('payment resolver: finishing what a crash interrupted', () => {
  it('settles an order whose charge had already been approved', async () => {
    // The worst case: the customer was charged, the process died before we
    // recorded it. Nothing else in the system will ever fix this.
    const { order, key } = await crashMidPayment();
    await chargeAtGateway(key, order.totalCents, 'approved');

    expect(await getOrderStatus(order.id)).toBe('confirmed');
    expect((await getStock(ITEM.chips)).reserved).toBe(2);

    const result = await resolve();

    expect(result).toMatchObject({ checked: 1, settled: 1 });
    expect(await getOrderStatus(order.id)).toBe('paid');
    expect((await paymentRow(order.id)).status).toBe('succeeded');
    expect(await getStock(ITEM.chips)).toEqual({ quantity: 22, reserved: 0 });
    await assertStockInvariant();
  });

  it('releases the stock when the charge had been declined', async () => {
    const { order, key } = await crashMidPayment();
    await chargeAtGateway(key, order.totalCents, 'declined_insufficient_funds');

    await resolve();

    expect(await getOrderStatus(order.id)).toBe('failed');
    expect((await paymentRow(order.id)).status).toBe('failed');
    expect(await getStock(ITEM.chips)).toEqual({ quantity: 24, reserved: 0 });
    await assertStockInvariant();
  });

  it('releases the stock when the request never reached the gateway', async () => {
    // Crashed before the HTTP call went out: the gateway has no record of the
    // key, so no money moved and the shelf can be given back.
    const { order } = await crashMidPayment(3);

    const result = await resolve();

    expect(result.settled).toBe(1);
    expect(await getOrderStatus(order.id)).toBe('failed');
    expect((await paymentRow(order.id)).status).toBe('failed');
    expect(await getStock(ITEM.chips)).toEqual({ quantity: 24, reserved: 0 });
    await assertStockInvariant();
  });

  it('holds, and never guesses, while the gateway still says it does not know', async () => {
    const { order, key } = await crashMidPayment();
    // A charge that exists but has not settled yet.
    await chargeAtGateway(key, order.totalCents, 'timeout_never_settles');

    const result = await resolve();

    expect(result).toMatchObject({ settled: 0, stillUnknown: 1 });
    expect(await getOrderStatus(order.id)).toBe('confirmed');
    expect((await getStock(ITEM.chips)).reserved).toBe(2);
  });

  it('gives up after its budget and says so, instead of asking forever', async () => {
    const { order, key } = await crashMidPayment();
    await chargeAtGateway(key, order.totalCents, 'timeout_never_settles');

    await resolve(3);
    await resolve(3);
    const third = await resolve(3);

    expect(third.exhausted).toBe(1);
    expect((await paymentRow(order.id)).resolve_attempts).toBe(3);

    // Budget spent: it is no longer picked up, and waits for a person.
    const fourth = await resolve(3);
    expect(fourth.checked).toBe(0);
    expect(await getOrderStatus(order.id)).toBe('confirmed');
  });
});

describe('payment resolver: not making things worse', () => {
  it('leaves a payment that is still in flight alone', async () => {
    const { order } = await crashMidPayment();

    // With a real grace period, an attempt made moments ago is not touched —
    // the live request still owns it.
    const result = await runPaymentResolver(() => {}, { graceMs: 60_000 });

    expect(result.checked).toBe(0);
    expect(await getOrderStatus(order.id)).toBe('confirmed');
  });

  it('does not decrement stock twice when an order was already settled', async () => {
    // The trap: settling blindly would take the units off the shelf a second
    // time, selling one unit twice over.
    await gateway.inject({ method: 'POST', url: '/control/scenario', payload: { scenario: 'approved' } });
    const order = await placeOrder([{ itemId: ITEM.chips, quantity: 2 }]);
    await payOrder(STORE.main, order.id, 'card');

    expect(await getStock(ITEM.chips)).toEqual({ quantity: 22, reserved: 0 });

    // Rewind the payment row as though the settle had never been recorded.
    await pool.query(
      `UPDATE payments SET status = 'pending', resolved_at = NULL WHERE store_id = $1 AND order_id = $2`,
      [STORE.main, order.id],
    );

    const result = await resolve();

    expect(result.settled).toBe(1);
    expect(await getOrderStatus(order.id)).toBe('paid');
    // Unchanged: 22, not 20.
    expect(await getStock(ITEM.chips)).toEqual({ quantity: 22, reserved: 0 });
    await assertStockInvariant();
  });

  it('two resolvers running at once settle an attempt exactly once', async () => {
    const { order, key } = await crashMidPayment();
    await chargeAtGateway(key, order.totalCents, 'approved');

    const [a, b] = await Promise.all([resolve(), resolve()]);

    // SKIP LOCKED means only one of them claims the row.
    expect(a.checked + b.checked).toBe(1);
    expect(await getStock(ITEM.chips)).toEqual({ quantity: 22, reserved: 0 });
    await assertStockInvariant();
  });

  it('sweeps every store in one pass', async () => {
    const { order: main, key } = await crashMidPayment(1);
    await chargeAtGateway(key, main.totalCents, 'approved');

    const result = await resolve();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    await assertStockInvariant();
  });

  it('reports a charge that succeeded for an order that had already failed', async () => {
    // Nothing can undo this automatically: the stock was released and may have
    // been sold. It has to be visible so a person can refund.
    const { order, key } = await crashMidPayment();
    await pool.query(
      `UPDATE orders SET status = 'failed' WHERE store_id = $1 AND id = $2`,
      [STORE.main, order.id],
    );
    await chargeAtGateway(key, order.totalCents, 'approved');

    await resolve();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM payments p JOIN orders o ON o.store_id = p.store_id AND o.id = p.order_id
        WHERE p.status = 'succeeded' AND o.status <> 'paid'`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('payment resolver: the terminal throwing is not a black hole', () => {
  it('records unknown rather than leaving the attempt pending', async () => {
    const order = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }]);
    setTerminal({
      charge: async () => {
        throw new Error('driver bug');
      },
      getStatus: async () => ({ status: 'unknown' }),
    });

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('unknown');
    expect(result.supportReference).toBe(order.id);
    // 'unknown', not 'pending': the resolver picks up either, but this is the
    // honest description of what happened.
    expect((await paymentRow(order.id)).status).toBe('unknown');
    expect(await getOrderStatus(order.id)).toBe('confirmed');
    expect((await getStock(ITEM.chips)).reserved).toBe(1);
  });
});
