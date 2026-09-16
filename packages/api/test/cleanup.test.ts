import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import { runSessionCleanup } from '../src/jobs/session-cleanup.js';
import {
  placeOrder,
  STORE,
  ITEM,
  assertStockInvariant,
  expireOrder,
  getOrderStatus,
  getStock,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

beforeAll(async () => {
  await setupDatabase();
  setTerminal(new FakeTerminal('approve'));
});
beforeEach(resetDatabase);
afterAll(closePool);

describe('session expiry job', () => {
  it('releases stock held by an expired pending order', async () => {
    const order = await placeOrder([
      { itemId: ITEM.chips, quantity: 4 },
    ]);
    expect((await getStock(ITEM.chips)).reserved).toBe(4);

    await expireOrder(order.id);
    const expired = await runSessionCleanup(() => {});

    expect(expired).toEqual([order.id]);
    expect(await getOrderStatus(order.id)).toBe('expired');
    const stock = await getStock(ITEM.chips);
    expect(stock.reserved).toBe(0);
    expect(stock.quantity).toBe(24); // physical count never touched by expiry
    await assertStockInvariant();
  });

  it('leaves unexpired orders alone', async () => {
    const order = await placeOrder([
      { itemId: ITEM.chips, quantity: 1 },
    ]);
    expect(await runSessionCleanup(() => {})).toEqual([]);
    expect(await getOrderStatus(order.id)).toBe('pending');
  });

  it('does not touch an order that was paid after the scan', async () => {
    const order = await placeOrder([
      { itemId: ITEM.chips, quantity: 2 },
    ]);
    await payOrder(STORE.main, order.id, 'card');
    await expireOrder(order.id); // backdate even though it is paid

    expect(await runSessionCleanup(() => {})).toEqual([]);
    expect(await getOrderStatus(order.id)).toBe('paid');
    // Stock stays decremented — the reaper must not give back sold goods.
    expect((await getStock(ITEM.chips)).quantity).toBe(22);
    await assertStockInvariant();
  });

  it('is safe to run repeatedly', async () => {
    const order = await placeOrder([
      { itemId: ITEM.chips, quantity: 3 },
    ]);
    await expireOrder(order.id);
    await runSessionCleanup(() => {});
    await runSessionCleanup(() => {});
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
    await assertStockInvariant();
  });
});
