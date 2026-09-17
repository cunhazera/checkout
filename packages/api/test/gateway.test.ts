import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '@checkout/gateway';
import type { ScenarioConfig } from '@checkout/gateway/scenarios';
import { closePool, pool } from '../src/db/pool.js';
import { payOrder, setTerminal } from '../src/services/payment.service.js';
import { HttpTerminal } from '../src/ports/http-terminal.js';
import { getOrder } from '../src/services/order.service.js';
import {
  BR_PRODUCT,
  PRODUCT,
  STORE,
  TOTEM,
  assertStockInvariant,
  getOrderStatus,
  getStock,
  placeOrder,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

let gateway: FastifyInstance;
let baseUrl: string;

/** Short timeout so the "gateway is too slow" cases resolve in about a second. */
const CLIENT_TIMEOUT_MS = 1_000;

beforeAll(async () => {
  await setupDatabase();
  gateway = buildGateway();
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const addr = gateway.server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('gateway did not bind a port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  setTerminal(new HttpTerminal(baseUrl, CLIENT_TIMEOUT_MS, 2));
});

beforeEach(async () => {
  await resetDatabase();
  await gateway.inject({ method: 'POST', url: '/control/reset' });
  // Restore the terminal here rather than at the end of the test that swaps it:
  // a failing assertion would otherwise leave every later test pointed at a
  // dead port, turning one failure into a cascade.
  setTerminal(new HttpTerminal(baseUrl, CLIENT_TIMEOUT_MS, 2));
});

afterAll(async () => {
  await gateway.close();
  await closePool();
});

const scenario = (cfg: ScenarioConfig) =>
  gateway.inject({ method: 'POST', url: '/control/scenario', payload: cfg });

const charges = async () =>
  (await gateway.inject({ method: 'GET', url: '/control/charges' })).json().charges as {
    chargeId: string;
    status: string;
    currency: string;
    amountCents: number;
  }[];

const buy = async (quantity = 2) => placeOrder([{ productId: PRODUCT.chips, quantity }]);

describe('payment gateway: the happy paths', () => {
  it('approves a charge and decrements stock once', async () => {
    await scenario({ scenario: 'approved' });
    const order = await buy();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('succeeded');
    expect(result.orderStatus).toBe('paid');
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
    expect(await charges()).toHaveLength(1);
    await assertStockInvariant();
  });

  it('sends the store currency, not a hard-coded one', async () => {
    await scenario({ scenario: 'approved' });
    const order = await placeOrder([{ productId: BR_PRODUCT.chips, quantity: 1 }], {
      store: STORE.br,
      totem: TOTEM.br,
    });
    await payOrder(STORE.br, order.id, 'card');

    expect(await charges()).toMatchObject([{ currency: 'BRL', amountCents: 1290 }]);
  });

  it('tolerates a slow but answering gateway', async () => {
    await scenario({ scenario: 'slow', delayMs: 300 });
    const order = await buy();
    expect((await payOrder(STORE.main, order.id, 'card')).status).toBe('succeeded');
  });
});

describe('payment gateway: declines', () => {
  it.each([
    ['declined_insufficient_funds', 'insufficient_funds'],
    ['declined_limit_exceeded', 'limit_exceeded'],
    ['declined_card_expired', 'card_expired'],
    ['declined_do_not_honour', 'do_not_honour'],
  ] as const)('%s releases the stock and reports %s', async (name, code) => {
    await scenario({ scenario: name });
    const order = await buy();
    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('failed');
    expect(result.declineReason).toBe(code);
    expect(await getOrderStatus(order.id)).toBe('failed');

    // A decline must never move physical stock, and must give the units back.
    const stock = await getStock(PRODUCT.chips);
    expect(stock).toEqual({ quantity: 24, reserved: 0 });
    await assertStockInvariant();
  });

  it('lets the customer buy again after a decline', async () => {
    await scenario({ scenario: 'declined_insufficient_funds' });
    const first = await buy();
    expect((await payOrder(STORE.main, first.id, 'card')).status).toBe('failed');

    await scenario({ scenario: 'approved' });
    const second = await buy();
    expect((await payOrder(STORE.main, second.id, 'card')).status).toBe('succeeded');
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
  });
});

describe('payment gateway: takes too long to answer', () => {
  it('finds the charge that WAS approved while we had given up', async () => {
    // The dangerous one: the customer's card was charged, but our request timed
    // out. Assuming failure here would give the goods away and refund nothing.
    await scenario({ scenario: 'timeout_then_approved', settleAfterMs: 300, respondAfterMs: 5_000 });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('succeeded');
    expect(await getOrderStatus(order.id)).toBe('paid');
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
    await assertStockInvariant();
  });

  it('finds the charge that was declined while we had given up', async () => {
    await scenario({ scenario: 'timeout_then_declined', settleAfterMs: 300, respondAfterMs: 5_000 });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('failed');
    expect(await getOrderStatus(order.id)).toBe('failed');
    expect(await getStock(PRODUCT.chips)).toEqual({ quantity: 24, reserved: 0 });
  });

  it('never guesses when the gateway never settles', async () => {
    await scenario({ scenario: 'timeout_never_settles', respondAfterMs: 5_000 });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('unknown');
    expect(result.supportReference).toBe(order.id);
    // Held, not released: the card may have been charged.
    expect(await getOrderStatus(order.id)).toBe('confirmed');
    expect(await getStock(PRODUCT.chips)).toEqual({ quantity: 24, reserved: 2 });

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE store_id = $1 AND order_id = $2',
      [STORE.main, order.id],
    );
    expect(rows[0]!.status).toBe('unknown');

    // And it is visible to staff rather than silently stuck.
    expect((await getOrder(STORE.main, order.id)).status).toBe('confirmed');
  });
});

describe('payment gateway: network and infrastructure failures', () => {
  it('retries a dropped connection and succeeds on the third attempt', async () => {
    await scenario({ scenario: 'network_error', failures: 2 });
    const order = await buy();

    expect((await payOrder(STORE.main, order.id, 'card')).status).toBe('succeeded');
    expect(await charges()).toHaveLength(1); // retried, but charged once
  });

  it('retries, retries, then refuses to guess when the connection keeps dropping', async () => {
    await scenario({ scenario: 'network_error' });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    // The bytes may have reached the gateway before the socket died, so this
    // is unknown rather than failed.
    expect(result.status).toBe('unknown');
    expect(await getOrderStatus(order.id)).toBe('confirmed');
    expect((await getStock(PRODUCT.chips)).reserved).toBe(2);
  });

  it('treats an unreachable gateway as a clean failure, not an unknown', async () => {
    // Nothing is listening, so the request provably never left: no charge can
    // exist, and the customer should simply be able to try again.
    // Port 9 is the discard service and behaves oddly across platforms; a high
    // unused port reliably refuses the connection.
    setTerminal(new HttpTerminal('http://127.0.0.1:59999', CLIENT_TIMEOUT_MS, 1));
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('failed');
    expect(result.declineReason).toBe('gateway_unreachable');
    expect(await getStock(PRODUCT.chips)).toEqual({ quantity: 24, reserved: 0 });
    await assertStockInvariant();
  });

  it('retries a 500 and succeeds', async () => {
    await scenario({ scenario: 'server_error', failures: 2 });
    const order = await buy();
    expect((await payOrder(STORE.main, order.id, 'card')).status).toBe('succeeded');
  });

  it('retries a 429 and succeeds', async () => {
    await scenario({ scenario: 'rate_limited', failures: 1 });
    const order = await buy();
    expect((await payOrder(STORE.main, order.id, 'card')).status).toBe('succeeded');
  });

  it('does not lose a real charge behind an unreadable response', async () => {
    // The gateway charged the card but answered with something we cannot read.
    // Reconciliation has to go back and ask.
    await scenario({ scenario: 'malformed_response' });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('succeeded');
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
  });

  it('reports a rejected request as failed without charging', async () => {
    await scenario({ scenario: 'currency_mismatch' });
    const order = await buy();

    const result = await payOrder(STORE.main, order.id, 'card');

    expect(result.status).toBe('failed');
    expect(result.declineReason).toBe('currency_not_supported');
    expect(await getStock(PRODUCT.chips)).toEqual({ quantity: 24, reserved: 0 });
    expect(await charges()).toHaveLength(0);
  });
});

describe('payment gateway: idempotency', () => {
  it('charges once when the same key is sent twice', async () => {
    await scenario({ scenario: 'approved' });
    const terminal = new HttpTerminal(baseUrl, CLIENT_TIMEOUT_MS, 2);
    const req = {
      amountCents: 500,
      currency: 'USD',
      method: 'card' as const,
      idempotencyKey: 'pay_test_1',
    };

    const first = await terminal.charge(req);
    const second = await terminal.charge(req);

    expect(first.status).toBe('succeeded');
    expect(second).toEqual(first); // replayed, not a second charge
    expect(await charges()).toHaveLength(1);
  });

  it('refuses a key replayed with a different amount', async () => {
    await scenario({ scenario: 'approved' });
    const terminal = new HttpTerminal(baseUrl, CLIENT_TIMEOUT_MS, 2);
    const key = 'pay_test_2';

    await terminal.charge({ amountCents: 500, currency: 'USD', method: 'card', idempotencyKey: key });
    const reused = await terminal.charge({
      amountCents: 900,
      currency: 'USD',
      method: 'card',
      idempotencyKey: key,
    });

    expect(reused).toMatchObject({ status: 'failed', declineReason: 'idempotency_key_reuse' });
    expect(await charges()).toHaveLength(1);
  });

  it('a double-tap on Pay reaches the gateway once', async () => {
    await scenario({ scenario: 'approved' });
    const order = await buy();

    const results = await Promise.allSettled([
      payOrder(STORE.main, order.id, 'card'),
      payOrder(STORE.main, order.id, 'card'),
    ]);

    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.status === 'succeeded'),
    ).toHaveLength(1);
    expect(await charges()).toHaveLength(1);
    expect((await getStock(PRODUCT.chips)).quantity).toBe(22);
  });
});
