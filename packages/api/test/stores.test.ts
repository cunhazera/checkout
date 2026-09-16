import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { cancelOrder, getOrder } from '../src/services/order.service.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { getMenu } from '../src/services/menu.service.js';
import { runSessionCleanup } from '../src/jobs/session-cleanup.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import {
  ITEM,
  STORE,
  TOTEM,
  assertStockInvariant,
  expireOrder,
  getStock,
  placeOrder,
  resetDatabase,
  setStock,
  setupDatabase,
} from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await setupDatabase();
  setTerminal(new FakeTerminal('approve'));
  app = await buildApp();
});
beforeEach(resetDatabase);
afterAll(async () => {
  await app.close();
  await closePool();
});

/**
 * Stores must behave as fully independent units. If any of these fail, data
 * or stock is leaking between stores — and splitting stores across database
 * shards later would silently break whatever depended on that leak.
 */
describe('store isolation', () => {
  it('prices an order in the store\'s own currency and price list', async () => {
    const us = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }]);
    const br = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }], { store: STORE.br, totem: TOTEM.br });

    expect(us).toMatchObject({ currency: 'USD', totalCents: 240 });
    expect(br).toMatchObject({ currency: 'BRL', totalCents: 1290 });
  });

  it('keeps stock separate: a sale in one store leaves the other untouched', async () => {
    await placeOrder([{ itemId: ITEM.chips, quantity: 3 }]);

    expect((await getStock(ITEM.chips, STORE.main)).reserved).toBe(3);
    expect((await getStock(ITEM.chips, STORE.br)).reserved).toBe(0);
    await assertStockInvariant();
  });

  it('lets two stores sell their own last unit at the same time', async () => {
    await setStock(ITEM.sandwich, 1, 0, STORE.main);
    await setStock(ITEM.sandwich, 1, 0, STORE.br);

    const results = await Promise.allSettled([
      placeOrder([{ itemId: ITEM.sandwich, quantity: 1 }]),
      placeOrder([{ itemId: ITEM.sandwich, quantity: 1 }], { store: STORE.br, totem: TOTEM.br }),
    ]);

    // Both succeed: the locks are on different rows, so they never contend.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await assertStockInvariant();
  });

  it('refuses an item outside the store\'s product range', async () => {
    // BR-SP-0001 does not sell Iced coffee, even though it is in the catalog.
    await expect(
      placeOrder([{ itemId: ITEM.coffee, quantity: 1 }], { store: STORE.br, totem: TOTEM.br }),
    ).rejects.toMatchObject({ code: 'item_unavailable' });
  });

  it('shows each store only its own menu', async () => {
    const main = await getMenu(STORE.main);
    const br = await getMenu(STORE.br);

    expect(main).toHaveLength(9);
    expect(br).toHaveLength(8);
    expect(br.find((i) => i.id === ITEM.coffee)).toBeUndefined();
    expect(br.find((i) => i.id === ITEM.chips)!.priceCents).toBe(1290);
  });

  it('invalidates only the store whose stock changed', async () => {
    const brBefore = await getMenu(STORE.br);
    await placeOrder([{ itemId: ITEM.chips, quantity: 2 }]);

    const mainAfter = await getMenu(STORE.main);
    const brAfter = await getMenu(STORE.br);

    expect(mainAfter.find((i) => i.id === ITEM.chips)!.availableQuantity).toBe(22);
    // The BR entry was never invalidated, so it is the same cached array.
    expect(brAfter).toBe(brBefore);
  });
});

describe('store-scoped access', () => {
  it('cannot read another store\'s order by id', async () => {
    const order = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }]);
    await expect(getOrder(STORE.br, order.id)).rejects.toMatchObject({ code: 'order_not_found' });

    const res = await app.inject({ method: 'GET', url: `/v1/stores/${STORE.br}/orders/${order.id}` });
    expect(res.statusCode).toBe(404);
  });

  it('cannot pay or cancel another store\'s order', async () => {
    const order = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }]);

    await expect(payOrder(STORE.br, order.id, 'card')).rejects.toMatchObject({ code: 'order_not_found' });
    await expect(cancelOrder(STORE.br, order.id)).rejects.toMatchObject({ code: 'order_not_found' });

    // Still pending and still holding its stock in its own store.
    expect((await getOrder(STORE.main, order.id)).status).toBe('pending');
    expect((await getStock(ITEM.chips)).reserved).toBe(1);
  });

  it('rejects a totem registered to a different store', async () => {
    await expect(
      placeOrder([{ itemId: ITEM.chips, quantity: 1 }], { store: STORE.main, totem: TOTEM.br }),
    ).rejects.toMatchObject({ code: 'totem_not_found' });
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('accepts orders from any of the store\'s five totems', async () => {
    const a = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }], { totem: TOTEM.main });
    const b = await placeOrder([{ itemId: ITEM.chips, quantity: 1 }], { totem: TOTEM.main2 });
    expect([a.totemId, b.totemId]).toEqual([TOTEM.main, TOTEM.main2]);
  });

  it('returns 404 for an unknown store and for a deactivated one', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/stores/c0000000-0000-4000-8000-000000000999/menu',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('store_not_found');

    await pool.query('UPDATE stores SET active = false WHERE id = $1', [STORE.br]);
    const inactive = await app.inject({ method: 'GET', url: `/v1/stores/${STORE.br}/menu` });
    expect(inactive.statusCode).toBe(404);
  });
});

describe('expiry across stores', () => {
  it('reaps expired orders in every store and releases each store\'s own stock', async () => {
    const us = await placeOrder([{ itemId: ITEM.chips, quantity: 2 }]);
    const br = await placeOrder([{ itemId: ITEM.chips, quantity: 5 }], { store: STORE.br, totem: TOTEM.br });
    await expireOrder(us.id);
    await expireOrder(br.id);

    const expired = await runSessionCleanup(() => {});
    expect(expired.sort()).toEqual([us.id, br.id].sort());

    expect((await getStock(ITEM.chips, STORE.main)).reserved).toBe(0);
    expect((await getStock(ITEM.chips, STORE.br)).reserved).toBe(0);
    await assertStockInvariant();
  });
});
