import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import {
  placeOrder,
  STORE,
  PRODUCT,
  assertStockInvariant,
  getOrderStatus,
  getStock,
  resetDatabase,
  setStock,
  setupDatabase,
} from './helpers.js';

const terminal = new FakeTerminal('approve');

beforeAll(async () => {
  await setupDatabase();
  setTerminal(terminal);
});
beforeEach(async () => {
  await resetDatabase();
  terminal.setMode('approve');
});
afterAll(closePool);

/**
 * "Two customers want the last one. First one buys it, second is denied."
 * The reservation race is covered in concurrency.test.ts; these follow the
 * losing customer all the way through to the purchase outcome.
 */
describe('two customers, one unit left', () => {
  it('sequential: first buys it, second is denied', async () => {
    await setStock(PRODUCT.sandwich, 1);

    // Customer A takes the last sandwich and pays for it.
    const a = await placeOrder([
      { productId: PRODUCT.sandwich, quantity: 1 },
    ]);
    const paid = await payOrder(STORE.main, a.id, 'card');
    expect(paid.status).toBe('succeeded');
    expect((await getStock(PRODUCT.sandwich)).quantity).toBe(0);

    // Customer B walks up a moment later.
    await expect(
      placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'product_out_of_stock', details: { available: 0 } });

    await assertStockInvariant();
  });

  it('simultaneous: exactly one customer gets to pay, the other is denied', async () => {
    await setStock(PRODUCT.sandwich, 1);

    const [a, b] = await Promise.allSettled([
      placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }]),
      placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }]),
    ]);

    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    const losers = [a, b].filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'product_out_of_stock',
    });

    // The winner completes the purchase; the physical unit leaves exactly once.
    const order = (winners[0] as PromiseFulfilledResult<{ id: string }>).value;
    const paid = await payOrder(STORE.main, order.id, 'card');
    expect(paid.status).toBe('succeeded');

    const stock = await getStock(PRODUCT.sandwich);
    expect(stock.quantity).toBe(0);
    expect(stock.reserved).toBe(0);
    await assertStockInvariant();
  });

  it('the denied customer can buy it if the winner fails to pay', async () => {
    await setStock(PRODUCT.sandwich, 1);

    const a = await placeOrder([
      { productId: PRODUCT.sandwich, quantity: 1 },
    ]);

    // B is denied while A holds the reservation.
    await expect(
      placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'product_out_of_stock' });

    // A's card is declined, which returns the unit to the shelf.
    terminal.setMode('decline');
    expect((await payOrder(STORE.main, a.id, 'card')).status).toBe('failed');
    expect((await getStock(PRODUCT.sandwich)).reserved).toBe(0);

    // Now B can buy it.
    terminal.setMode('approve');
    const b = await placeOrder([
      { productId: PRODUCT.sandwich, quantity: 1 },
    ]);
    expect((await payOrder(STORE.main, b.id, 'card')).status).toBe('succeeded');
    expect((await getStock(PRODUCT.sandwich)).quantity).toBe(0);
    await assertStockInvariant();
  });
});

/**
 * The kiosk risk is a double-tap on "Pay": two requests for the same order,
 * in flight at the same time. Exactly one charge must reach the terminal.
 */
describe('payment idempotency', () => {
  it('sequential: paying an already-paid order is refused', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 2 },
    ]);
    expect((await payOrder(STORE.main, order.id, 'card')).status).toBe('succeeded');

    await expect(payOrder(STORE.main, order.id, 'card')).rejects.toMatchObject({
      code: 'order_not_pending',
    });

    // Charged once, decremented once.
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments WHERE order_id = $1 AND status = 'succeeded'`,
      [order.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('concurrent double-tap charges the card exactly once', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 2 },
    ]);

    const results = await Promise.allSettled([
      payOrder(STORE.main, order.id, 'card'),
      payOrder(STORE.main, order.id, 'card'),
    ]);

    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 'succeeded',
    );
    expect(succeeded).toHaveLength(1);

    // The decisive assertion: only one attempt ever reached the terminal.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments WHERE order_id = $1`,
      [order.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);

    // And stock moved exactly once.
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
    expect(await getOrderStatus(order.id)).toBe('paid');
    await assertStockInvariant();
  });

  it('three simultaneous taps still produce one charge', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.cola, quantity: 1 },
    ]);

    const results = await Promise.allSettled([
      payOrder(STORE.main, order.id, 'card'),
      payOrder(STORE.main, order.id, 'card'),
      payOrder(STORE.main, order.id, 'card'),
    ]);

    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.status === 'succeeded'),
    ).toHaveLength(1);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments WHERE order_id = $1`,
      [order.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect((await getStock(PRODUCT.cola)).quantity).toBe(19);
    await assertStockInvariant();
  });
});
