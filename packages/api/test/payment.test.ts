import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import { runSessionCleanup } from '../src/jobs/session-cleanup.js';
import {
  placeOrder,
  STORE,
  PRODUCT,
  assertStockInvariant,
  expireOrder,
  getOrderStatus,
  getStock,
  resetDatabase,
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

const newOrder = () =>
  placeOrder([{ productId: PRODUCT.chips, quantity: 2 }]);

describe('payment (ADR-003)', () => {
  it('on success: marks paid and decrements physical stock exactly once', async () => {
    const order = await newOrder();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('succeeded');
    expect(await getOrderStatus(order.id)).toBe('paid');

    const stock = await getStock(PRODUCT.chips);
    expect(stock.quantity).toBe(22); // 24 - 2, decremented only here
    expect(stock.reserved).toBe(0);
    await assertStockInvariant();
  });

  it('on decline: releases the reservation and leaves physical stock alone', async () => {
    terminal.setMode('decline');
    const order = await newOrder();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('failed');
    expect(result.declineReason).toBe('card_declined');
    expect(await getOrderStatus(order.id)).toBe('failed');

    const stock = await getStock(PRODUCT.chips);
    expect(stock.quantity).toBe(24);
    expect(stock.reserved).toBe(0);
    await assertStockInvariant();
  });

  it('on unresolved timeout: holds the reservation and returns a support reference', async () => {
    terminal.setMode('timeout');
    const order = await newOrder();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('unknown');
    expect(result.supportReference).toBe(order.id);
    // Never assume either way. The order sits in 'confirmed' — payment in
    // flight, outcome unknown — and stock stays held.
    expect(await getOrderStatus(order.id)).toBe('confirmed');

    const stock = await getStock(PRODUCT.chips);
    expect(stock.quantity).toBe(24);
    expect(stock.reserved).toBe(2);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE order_id = $1',
      [order.id],
    );
    expect(rows[0]!.status).toBe('unknown');

    // The expiry reaper must NOT free this stock even once the TTL passes:
    // the card may well have been charged. Only a human can resolve it.
    await expireOrder(order.id);
    expect(await runSessionCleanup(() => {})).toEqual([]);
    expect((await getStock(PRODUCT.chips)).reserved).toBe(2);
    expect(await getOrderStatus(order.id)).toBe('confirmed');
  }, 60_000);

  it('resolves an unknown payment if the processor confirms during polling', async () => {
    terminal.setMode('timeout_then_approve');
    const order = await newOrder();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('succeeded');
    expect(await getOrderStatus(order.id)).toBe('paid');
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
    await assertStockInvariant();
  }, 60_000);

  it('allows a retry after a decline, with a fresh idempotency key', async () => {
    terminal.setMode('decline');
    const order = await newOrder();
    await payOrder(STORE.main, order.id, 'card');

    // The order is now 'failed' and its stock released, so the totem's retry
    // path creates a new order rather than re-paying the old one.
    await expect(payOrder(STORE.main, order.id, 'card')).rejects.toMatchObject({ code: 'order_not_pending' });

    const retry = await newOrder();
    terminal.setMode('approve');
    const second = await payOrder(STORE.main, retry.id, 'card');
    expect(second.status).toBe('succeeded');

    const { rows } = await pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM payments ORDER BY created_at',
    );
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(rows.length);
  });

  it('refuses to pay an expired order', async () => {
    const order = await newOrder();
    await expireOrder(order.id);
    await expect(payOrder(STORE.main, order.id, 'card')).rejects.toMatchObject({ code: 'order_expired' });
  });

  it('refuses to pay the same order twice', async () => {
    const order = await newOrder();
    await payOrder(STORE.main, order.id, 'card');
    await expect(payOrder(STORE.main, order.id, 'card')).rejects.toMatchObject({ code: 'order_not_pending' });
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22); // not decremented twice
  });

  it('records the chosen payment method', async () => {
    const order = await newOrder();
    await payOrder(STORE.main, order.id, 'qr');
    const { rows } = await pool.query<{ method: string }>(
      'SELECT method FROM payments WHERE order_id = $1',
      [order.id],
    );
    expect(rows[0]!.method).toBe('qr');
  });
});
