import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { setTerminal } from '../src/services/payment.service.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import { PRODUCT, STORE, TOTEM, resetDatabase, setupDatabase } from './helpers.js';

let app: FastifyInstance;
const terminal = new FakeTerminal('approve');
const base = `/v1/stores/${STORE.main}`;

beforeAll(async () => {
  await setupDatabase();
  setTerminal(terminal);
  app = await buildApp();
});
beforeEach(async () => {
  await resetDatabase();
  terminal.setMode('approve');
});
afterAll(async () => {
  await app.close();
  await closePool();
});

const createOrder = async (items: { productId: string; quantity: number }[], storeBase = base, totemId: string = TOTEM.main) => {
  const session = (await app.inject({ method: 'POST', url: `${storeBase}/sessions` })).json();
  return app.inject({
    method: 'POST',
    url: `${storeBase}/orders`,
    payload: { sessionId: session.sessionId, totemId, items },
  });
};

describe('HTTP surface', () => {
  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      // `waiting` above zero is the first sign the pool is the bottleneck.
      pool: { max: expect.any(Number), waiting: 0 },
    });
  });

  it('GET /v1/stores/:storeId returns store settings', async () => {
    const res = await app.inject({ method: 'GET', url: base });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: STORE.main,
      code: 'LOCAL-0001',
      currency: 'USD',
      locale: 'en-US',
      taxBasisPoints: 0,
    });
  });

  it('GET .../health/stock reports the ADR-004 invariant holding', async () => {
    const res = await app.inject({ method: 'GET', url: `${base}/health/stock` });
    expect(res.json().ok).toBe(true);
  });

  it('GET .../health/orders reports nothing needing reconciliation', async () => {
    const res = await app.inject({ method: 'GET', url: `${base}/health/orders` });
    expect(res.json()).toEqual({ ok: true, needsReconciliation: [], chargedButNotPaid: [] });
  });

  it('GET .../menu returns prices in cents with their currency', async () => {
    const res = await app.inject({ method: 'GET', url: `${base}/menu` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('USD');
    expect(body.items).toHaveLength(9);
    expect(typeof body.items[0].priceCents).toBe('number');
  });

  it('runs the full happy path: session -> order -> payment', async () => {
    const created = await createOrder([{ productId: PRODUCT.chips, quantity: 2 }]);
    expect(created.statusCode).toBe(201);
    const order = created.json();
    expect(order).toMatchObject({ storeId: STORE.main, totemId: TOTEM.main, currency: 'USD', totalCents: 480 });

    const paid = await app.inject({
      method: 'POST',
      url: `${base}/orders/${order.id}/payments`,
      payload: { method: 'card' },
    });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().status).toBe('succeeded');

    const reread = await app.inject({ method: 'GET', url: `${base}/orders/${order.id}` });
    expect(reread.json().status).toBe('paid');
  });

  it('returns 201 for a declined payment too — the attempt was created', async () => {
    terminal.setMode('decline');
    const order = (await createOrder([{ productId: PRODUCT.chips, quantity: 1 }])).json();
    const res = await app.inject({ method: 'POST', url: `${base}/orders/${order.id}/payments`, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('failed');
  });

  it('returns 409 with a machine-readable code when an item is sold out', async () => {
    const res = await createOrder([{ productId: PRODUCT.coffee, quantity: 1 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'product_out_of_stock', productId: PRODUCT.coffee });
  });

  it('returns 404 for an unknown order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${base}/orders/33333333-3333-4333-8333-000000000000`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('order_not_found');
  });

  it('POST .../cancel releases stock and is idempotent', async () => {
    const order = (await createOrder([{ productId: PRODUCT.chips, quantity: 1 }])).json();

    const first = await app.inject({ method: 'POST', url: `${base}/orders/${order.id}/cancel` });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('cancelled');

    const second = await app.inject({ method: 'POST', url: `${base}/orders/${order.id}/cancel` });
    expect(second.json().status).toBe('cancelled');
  });

  // Regression: the totem's fetch wrapper once set content-type on every request.
  it('accepts bodyless POSTs that still declare application/json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/sessions`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ storeId: STORE.main });
  });

  it('rejects a malformed JSON body with a clean error code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('no longer serves the pre-v1 routes', async () => {
    for (const [method, url] of [
      ['GET', '/menu'],
      ['GET', '/config'],
      ['POST', '/session/start'],
      ['POST', '/orders'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
