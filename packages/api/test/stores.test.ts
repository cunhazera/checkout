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
  BR_PRODUCT,
  PRODUCT,
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
    const us = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }]);
    const br = await placeOrder([{ productId: BR_PRODUCT.chips, quantity: 1 }], {
      store: STORE.br,
      totem: TOTEM.br,
    });

    expect(us).toMatchObject({ currency: 'USD', totalCents: 240 });
    expect(br).toMatchObject({ currency: 'BRL', totalCents: 1290 });
  });

  it('records the currency on the order, not read live from the store', async () => {
    // A store that ever changed currency must not rewrite what past customers
    // were charged in.
    const br = await placeOrder([{ productId: BR_PRODUCT.chips, quantity: 1 }], {
      store: STORE.br,
      totem: TOTEM.br,
    });
    await pool.query(`UPDATE stores SET currency = 'USD' WHERE id = $1`, [STORE.br]);

    expect((await getOrder(STORE.br, br.id)).currency).toBe('BRL');
  });

  it('refuses an order that would cost nothing', async () => {
    await pool.query(`UPDATE products SET price_cents = 0 WHERE store_id = $1 AND id = $2`, [
      STORE.main,
      PRODUCT.chips,
    ]);
    await expect(placeOrder([{ productId: PRODUCT.chips, quantity: 1 }])).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
  });

  it('keeps stock separate: a sale in one store leaves the other untouched', async () => {
    await placeOrder([{ productId: PRODUCT.chips, quantity: 3 }]);

    expect((await getStock(PRODUCT.chips, STORE.main)).reserved).toBe(3);
    expect((await getStock(BR_PRODUCT.chips, STORE.br)).reserved).toBe(0);
    await assertStockInvariant();
  });

  it('lets two stores sell their own last unit at the same time', async () => {
    await setStock(PRODUCT.sandwich, 1, 0, STORE.main);
    await setStock(BR_PRODUCT.water, 1, 0, STORE.br);

    const results = await Promise.allSettled([
      placeOrder([{ productId: PRODUCT.sandwich, quantity: 1 }]),
      placeOrder([{ productId: BR_PRODUCT.water, quantity: 1 }], {
        store: STORE.br,
        totem: TOTEM.br,
      }),
    ]);

    // Both succeed: the locks are on different rows, so they never contend.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await assertStockInvariant();
  });

  it('refuses another store\'s product id outright', async () => {
    // Product ids belong to one store. BR-SP-0001 has no row with this id, so
    // there is nothing to sell and nothing to reserve.
    await expect(
      placeOrder([{ productId: PRODUCT.coffee, quantity: 1 }], { store: STORE.br, totem: TOTEM.br }),
    ).rejects.toMatchObject({ code: 'product_unavailable' });
  });

  it('shows each store only its own menu', async () => {
    const main = await getMenu(STORE.main);
    const br = await getMenu(STORE.br);

    expect(main).toHaveLength(9);
    expect(br).toHaveLength(8);
    // Not one shared product in common: the two menus are different rows.
    expect(main.some((p) => br.some((b) => b.id === p.id))).toBe(false);
    expect(br.find((p) => p.id === BR_PRODUCT.chips)!.priceCents).toBe(1290);
    expect(br.find((p) => p.id === BR_PRODUCT.chips)!.name).toBe('Batata frita');
  });

  it('shows the sale immediately, and only in the store that made it', async () => {
    // There is no menu cache: every read is current. A reservation must show up
    // at once in its own store and not at all in the other.
    const brBefore = (await getMenu(STORE.br)).find((p) => p.id === BR_PRODUCT.chips)!;
    await placeOrder([{ productId: PRODUCT.chips, quantity: 2 }]);

    const mainAfter = await getMenu(STORE.main);
    const brAfter = (await getMenu(STORE.br)).find((p) => p.id === BR_PRODUCT.chips)!;

    expect(mainAfter.find((p) => p.id === PRODUCT.chips)!.availableQuantity).toBe(22);
    expect(brAfter.availableQuantity).toBe(brBefore.availableQuantity);
  });
});

describe('store-scoped access', () => {
  it('cannot read another store\'s order by id', async () => {
    const order = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }]);
    await expect(getOrder(STORE.br, order.id)).rejects.toMatchObject({ code: 'order_not_found' });

    const res = await app.inject({ method: 'GET', url: `/v1/stores/${STORE.br}/orders/${order.id}` });
    expect(res.statusCode).toBe(404);
  });

  it('cannot pay or cancel another store\'s order', async () => {
    const order = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }]);

    await expect(payOrder(STORE.br, order.id, 'card')).rejects.toMatchObject({ code: 'order_not_found' });
    await expect(cancelOrder(STORE.br, order.id)).rejects.toMatchObject({ code: 'order_not_found' });

    // Still pending and still holding its stock in its own store.
    expect((await getOrder(STORE.main, order.id)).status).toBe('pending');
    expect((await getStock(PRODUCT.chips)).reserved).toBe(1);
  });

  it('rejects a totem registered to a different store', async () => {
    await expect(
      placeOrder([{ productId: PRODUCT.chips, quantity: 1 }], { store: STORE.main, totem: TOTEM.br }),
    ).rejects.toMatchObject({ code: 'totem_not_found' });
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
  });

  it('accepts orders from any of the store\'s five totems', async () => {
    const a = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }], { totem: TOTEM.main });
    const b = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }], { totem: TOTEM.main2 });
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
    const us = await placeOrder([{ productId: PRODUCT.chips, quantity: 2 }]);
    const br = await placeOrder([{ productId: BR_PRODUCT.chips, quantity: 5 }], {
      store: STORE.br,
      totem: TOTEM.br,
    });
    await expireOrder(us.id);
    await expireOrder(br.id);

    const expired = await runSessionCleanup(() => {});
    expect(expired.sort()).toEqual([us.id, br.id].sort());

    expect((await getStock(PRODUCT.chips, STORE.main)).reserved).toBe(0);
    expect((await getStock(BR_PRODUCT.chips, STORE.br)).reserved).toBe(0);
    await assertStockInvariant();
  });
});
