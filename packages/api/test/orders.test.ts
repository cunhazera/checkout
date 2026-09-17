import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { cancelOrder, getOrder } from '../src/services/order.service.js';
import { getMenu } from '../src/services/menu.service.js';
import { AppError } from '../src/errors.js';
import {
  PRODUCT,
  STORE,
  TOTEM,
  assertStockInvariant,
  getOrderStatus,
  getStock,
  placeOrder,
  resetDatabase,
  setStock,
  setupDatabase,
} from './helpers.js';

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(closePool);

describe('one open order per totem', () => {
  it('cancels the basket a customer walked away from', async () => {
    // Otherwise their reservation holds stock for the full TTL and the next
    // person at that screen is told "sold out" for something on the shelf.
    const abandoned = await placeOrder([{ productId: PRODUCT.chips, quantity: 3 }]);
    expect((await getStock(PRODUCT.chips)).reserved).toBe(3);

    const next = await placeOrder([{ productId: PRODUCT.cola, quantity: 1 }]);

    expect(await getOrderStatus(abandoned.id)).toBe('cancelled');
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
    expect(await getOrderStatus(next.id)).toBe('pending');
    await assertStockInvariant();
  });

  it('leaves other totems alone', async () => {
    const onT1 = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }], { totem: TOTEM.main });
    await placeOrder([{ productId: PRODUCT.cola, quantity: 1 }], { totem: TOTEM.main2 });

    // Five screens in a shop sell at the same time; only the same screen's
    // previous basket is closed.
    expect(await getOrderStatus(onT1.id)).toBe('pending');
    expect((await getStock(PRODUCT.chips)).reserved).toBe(1);
  });

  it('refuses to start a new order while a payment is in flight', async () => {
    const paying = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }]);
    await pool.query(`UPDATE orders SET status = 'confirmed' WHERE store_id = $1 AND id = $2`, [
      STORE.main,
      paying.id,
    ]);

    // Cancelling this one could release stock for goods the customer has
    // already been charged for.
    await expect(placeOrder([{ productId: PRODUCT.cola, quantity: 1 }])).rejects.toMatchObject({
      code: 'payment_in_flight',
    });
    expect((await getStock(PRODUCT.chips)).reserved).toBe(1);
    expect((await getStock(PRODUCT.cola)).reserved).toBe(0);
  });

  it('lets the totem start again once the payment settled', async () => {
    const first = await placeOrder([{ productId: PRODUCT.chips, quantity: 1 }]);
    await cancelOrder(STORE.main, first.id);

    const second = await placeOrder([{ productId: PRODUCT.cola, quantity: 1 }]);
    expect(await getOrderStatus(second.id)).toBe('pending');
    await assertStockInvariant();
  });
});

describe('menu', () => {
  it('lists active items with availability', async () => {
    const items = await getMenu(STORE.main);
    expect(items).toHaveLength(9);
    const coffee = items.find((i) => i.id === PRODUCT.coffee)!;
    expect(coffee.availableQuantity).toBe(0);
    expect(coffee.outOfStock).toBe(true);
  });

  it('reflects a reservation in available quantity', async () => {
    const before = (await getMenu(STORE.main)).find((i) => i.id === PRODUCT.chips)!;
    await placeOrder([{ productId: PRODUCT.chips, quantity: 2 }]);
    const after = (await getMenu(STORE.main)).find((i) => i.id === PRODUCT.chips)!;
    expect(after.availableQuantity).toBe(before.availableQuantity - 2);
  });
});

describe('createOrder', () => {
  it('reserves stock and snapshots prices', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 2 },
      { productId: PRODUCT.cola, quantity: 1 },
    ]);

    expect(order.status).toBe('pending');
    // 240*2 + 210 = 690
    expect(order.subtotalCents).toBe(690);
    expect(order.totalCents).toBe(690);

    const chips = await getStock(PRODUCT.chips);
    expect(chips.reserved).toBe(2);
    expect(chips.quantity).toBe(24); // physical count untouched until payment
    await assertStockInvariant();
  });

  it('rejects an order for a sold-out item without reserving anything', async () => {
    await expect(
      placeOrder([{ productId: PRODUCT.coffee, quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'product_out_of_stock' });

    expect((await getStock(PRODUCT.coffee)).reserved).toBe(0);
  });

  it('leaves no partial reservation when a later line fails', async () => {
    await expect(
      placeOrder([
        { productId: PRODUCT.chips, quantity: 2 },
        { productId: PRODUCT.coffee, quantity: 1 },
      ]),
    ).rejects.toThrow(AppError);

    // The whole transaction rolled back, including the chips reservation.
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
    await assertStockInvariant();
  });

  it('rejects unknown and inactive items', async () => {
    await expect(
      placeOrder([
        { productId: '22222222-2222-4222-8222-000000000000', quantity: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'product_unavailable' });
  });

  it('rejects duplicate lines for the same item', async () => {
    await expect(
      placeOrder([
        { productId: PRODUCT.chips, quantity: 1 },
        { productId: PRODUCT.chips, quantity: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects empty orders and non-positive quantities', async () => {
    await expect(placeOrder([])).rejects.toMatchObject({ code: 'bad_request' });
    await expect(placeOrder([{ productId: PRODUCT.chips, quantity: 0 }])).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('keeps the price the customer saw even if the catalog changes later', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 1 },
    ]);
    await setStock(PRODUCT.chips, 24, 1);
    const reread = await getOrder(STORE.main, order.id);
    expect(reread.items[0]!.unitPriceCents).toBe(240);
  });
});

describe('abandonOrder', () => {
  it('releases reservations and cancels', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 3 },
    ]);
    expect((await getStock(PRODUCT.chips)).reserved).toBe(3);

    const { status } = await cancelOrder(STORE.main, order.id);
    expect(status).toBe('cancelled');
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
    await assertStockInvariant();
  });

  it('is idempotent — abandoning twice does not double-release', async () => {
    const order = await placeOrder([
      { productId: PRODUCT.chips, quantity: 3 },
    ]);
    await cancelOrder(STORE.main, order.id);
    await cancelOrder(STORE.main, order.id);
    expect((await getStock(PRODUCT.chips)).reserved).toBe(0);
    await assertStockInvariant();
  });
});
