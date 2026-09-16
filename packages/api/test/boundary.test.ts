import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { setTerminal } from '../src/services/payment.service.js';
import { FakeTerminal } from '../src/ports/fake-terminal.js';
import { ITEM, STORE, TOTEM, getStock, resetDatabase, setupDatabase } from './helpers.js';

let app: FastifyInstance;
const base = `/v1/stores/${STORE.main}`;

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

const order = (body: unknown) =>
  app.inject({ method: 'POST', url: `${base}/orders`, payload: body as object });

const valid = (items: unknown = [{ itemId: ITEM.chips, quantity: 1 }]) => ({
  sessionId: 's',
  totemId: TOTEM.main,
  items,
});

// Fastify's own 4xx errors must not be reported as server failures.
describe('client errors keep their status', () => {
  it('returns 413 for an oversized body, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...valid(), pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('returns 415 for an unsupported content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders`,
      headers: { 'content-type': 'application/xml' },
      payload: '<order/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_media_type');
  });
});

// Malformed input is rejected by schema before it reaches Postgres.
describe('request schemas', () => {
  it('rejects a non-UUID store id with 400, not a database error', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/stores/not-a-uuid/menu' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects a non-UUID order id with 400', async () => {
    for (const [method, url] of [
      ['GET', `${base}/orders/not-a-uuid`],
      ['POST', `${base}/orders/not-a-uuid/payments`],
      ['POST', `${base}/orders/not-a-uuid/cancel`],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().error).toBe('validation_error');
    }
  });

  it('rejects a non-UUID itemId without reserving anything', async () => {
    const res = await order(valid([{ itemId: 'abc', quantity: 1 }]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('requires a totemId', async () => {
    const { totemId: _omit, ...body } = valid();
    const res = await order(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects a sessionId longer than the column', async () => {
    const res = await order({ ...valid(), sessionId: 'x'.repeat(256) });
    expect(res.statusCode).toBe(400);
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('does not coerce a string quantity', async () => {
    const res = await order(valid([{ itemId: ITEM.chips, quantity: '2' }]));
    expect(res.statusCode).toBe(400);
  });

  it('still pays when the request has no body at all', async () => {
    const created = (await order(valid())).json();
    const res = await app.inject({ method: 'POST', url: `${base}/orders/${created.id}/payments` });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('succeeded');
  });

  it('rejects an unknown payment method', async () => {
    const created = (await order(valid())).json();
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders/${created.id}/payments`,
      payload: { method: 'cash' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('caps how many lines one order may contain', async () => {
    // Each line takes a row lock; an unbounded list is an easy way to hurt a
    // shard once this API is reachable from outside the machine.
    const many = Array.from({ length: 51 }, () => ({ itemId: ITEM.chips, quantity: 1 }));
    const res = await order(valid(many));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('caps the quantity of a single line', async () => {
    const res = await order(valid([{ itemId: ITEM.chips, quantity: 100 }]));
    expect(res.statusCode).toBe(400);
  });

  it('drops unknown fields instead of passing them on', async () => {
    const res = await order({
      ...valid([{ itemId: ITEM.chips, quantity: 1, priceCents: 1 }]),
      totalCents: 1,
      storeId: STORE.br,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ totalCents: 240, storeId: STORE.main });
  });
});

// The empty-body special case must not weaken JSON parsing.
describe('JSON body parsing', () => {
  const poisoned = (key: string) =>
    `{${key},"sessionId":"s","totemId":"${TOTEM.main}","items":[{"itemId":"${ITEM.chips}","quantity":1}]}`;

  it('rejects prototype poisoning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders`,
      headers: { 'content-type': 'application/json' },
      // An otherwise valid order, so only the parser can be what rejects it.
      payload: poisoned('"__proto__":{"polluted":true}'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('rejects constructor.prototype poisoning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: poisoned('"constructor":{"prototype":{"polluted":true}}'),
    });
    expect(res.statusCode).toBe(400);
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });
});
