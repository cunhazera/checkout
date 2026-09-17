import { pool, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest, orderExpired, orderNotFound, orderNotPending } from '../errors.js';
import { cents } from '../money.js';
import { commitReservations, releaseReservations } from './stock.service.js';
import { getStore } from './store.service.js';
import type { PaymentMethod, PaymentTerminal, ChargeResult } from '../ports/payment-terminal.js';
import { FakeTerminal } from '../ports/fake-terminal.js';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface PayResult {
  storeId: string;
  orderId: string;
  paymentId: string;
  status: PaymentStatus;
  orderStatus: string;
  amountCents: number;
  declineReason?: string;
  /** Set when status is 'unknown' — the totem shows this to the customer so
   *  staff can reconcile. Never implies the card was or was not charged. */
  supportReference?: string;
}

let terminal: PaymentTerminal = new FakeTerminal();

/** Swapped at startup (Phase 7) or in tests. */
export function setTerminal(next: PaymentTerminal): void {
  terminal = next;
}
export function getTerminal(): PaymentTerminal {
  return terminal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Identifies one payment attempt through the settle and reconcile steps. */
export interface Attempt {
  storeId: string;
  orderId: string;
  paymentId: string;
  amountCents: number;
}

/**
 * ADR-003: synchronous payment. The customer is standing at the totem, so the
 * result must resolve before the request returns — including the full 30s
 * reconciliation window for an unknown outcome.
 */
export async function payOrder(
  storeId: string,
  orderId: string,
  method: PaymentMethod,
): Promise<PayResult> {
  if (!['card', 'wallet', 'qr'].includes(method)) {
    throw badRequest('Unknown payment method', { method });
  }

  // 1-4: validate, claim the order, then record the attempt before talking to
  // the terminal. If the process dies mid-charge, the payments row is the only
  // evidence that money may have moved.
  const { amountCents, idempotencyKey, paymentId } = await withTransaction(async (db) => {
    const { rows } = await db.query<{ status: string; total_cents: number; expired: boolean }>(
      `SELECT status, total_cents, (expires_at < NOW()) AS expired
         FROM orders WHERE store_id = $1 AND id = $2 FOR UPDATE`,
      [storeId, orderId],
    );
    const order = rows[0];
    if (!order) throw orderNotFound(orderId);
    if (order.status !== 'pending') throw orderNotPending(orderId, order.status);
    if (order.expired) throw orderExpired(orderId);

    // Claim the order for this attempt BEFORE releasing the row lock. The
    // status must leave 'pending' now, not after the charge returns — otherwise
    // a double-tap on the kiosk's Pay button slips a second request through
    // this same gate while the first is still talking to the terminal, and the
    // customer is charged twice. 'confirmed' is the arch doc's payment-in-flight
    // state, and the expiry reaper deliberately ignores it.
    await db.query(
      `UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE store_id = $1 AND id = $2`,
      [storeId, orderId],
    );

    const { rows: attemptRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments WHERE store_id = $1 AND order_id = $2`,
      [storeId, orderId],
    );
    const attempt = Number(attemptRows[0]!.count) + 1;
    const key = `pay_${orderId}_${attempt}`;

    const { rows: inserted } = await db.query<{ id: string }>(
      `INSERT INTO payments (store_id, order_id, amount_cents, status, idempotency_key, method)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING id`,
      [storeId, orderId, order.total_cents, key, method],
    );

    return {
      amountCents: cents(order.total_cents),
      idempotencyKey: key,
      paymentId: inserted[0]!.id,
    };
  });

  // 5: the charge itself, outside any transaction — holding a DB transaction
  // open across a gateway round-trip would pin locks for up to 30 seconds.
  const { currency } = await getStore(storeId);
  const attempt: Attempt = { storeId, orderId, paymentId, amountCents };

  let result: ChargeResult;
  try {
    result = await terminal.charge({ amountCents, currency, method, idempotencyKey });
  } catch (err) {
    // A driver is supposed to turn every failure into one of the three
    // outcomes. If one throws anyway, the request may still have reached the
    // gateway, so the honest answer is 'unknown'. Recording that — rather than
    // leaving the row 'pending' and the exception to bubble up — is what hands
    // the attempt to the resolver instead of stranding it.
    console.error('payment terminal threw', { orderId, idempotencyKey, err });
    await pool.query(
      `UPDATE payments SET status = 'unknown' WHERE store_id = $1 AND id = $2`,
      [storeId, paymentId],
    );
    return {
      storeId,
      orderId,
      paymentId,
      status: 'unknown',
      orderStatus: 'confirmed',
      amountCents,
      supportReference: orderId,
    };
  }

  if (result.status === 'unknown') return reconcileUnknown(attempt, idempotencyKey);
  return applyOutcome(attempt, result);
}

/**
 * Applies a settled outcome (succeeded or failed) to the order and its stock.
 *
 * Safe to call more than once for the same attempt, which matters because both
 * a live request and the resolver can arrive at the same answer. Stock only
 * moves on the real transition out of 'confirmed'; a second call finds nothing
 * to update and leaves stock alone.
 */
export async function applyOutcome(attempt: Attempt, result: ChargeResult): Promise<PayResult> {
  return result.status === 'succeeded'
    ? settleSuccess(attempt, result)
    : settleFailure(attempt, result);
}

async function settleSuccess(
  { storeId, orderId, paymentId, amountCents }: Attempt,
  result: ChargeResult,
): Promise<PayResult> {
  // The card has already been charged. Losing this write means money moved
  // with no record of it, so contention gets far more patience here than on a
  // transaction that could simply be re-driven by the customer.
  const orderStatus = await withTransaction(async (db) => {
    await db.query(
      `UPDATE payments
          SET status = 'succeeded', resolved_at = NOW(),
              provider_payment_id = COALESCE($3, provider_payment_id)
        WHERE store_id = $1 AND id = $2`,
      [storeId, paymentId, result.providerPaymentId ?? null],
    );

    // Only the transition out of 'confirmed' may move stock. Without this
    // condition a resolver and a live request settling the same attempt would
    // each decrement the shelf, selling one unit twice over.
    const { rowCount } = await db.query(
      `UPDATE orders SET status = 'paid', updated_at = NOW()
        WHERE store_id = $1 AND id = $2 AND status = 'confirmed'`,
      [storeId, orderId],
    );
    if (rowCount === 1) {
      // ADR-004: the only place physical stock is decremented.
      await commitReservations(db, storeId, orderId);
      return 'paid';
    }

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM orders WHERE store_id = $1 AND id = $2`,
      [storeId, orderId],
    );
    return rows[0]?.status ?? 'unknown';
  }, { retries: 20 });

  if (orderStatus !== 'paid') {
    // The charge succeeded but the order had already moved on — most likely
    // released as failed before the gateway confirmed. The stock is gone and
    // the customer has been charged, so this needs a person and a refund.
    console.error('payment succeeded for an order that is not paid', {
      storeId,
      orderId,
      paymentId,
      orderStatus,
    });
  }

  return {
    storeId,
    orderId,
    paymentId,
    status: 'succeeded',
    orderStatus,
    amountCents,
  };
}

async function settleFailure(
  { storeId, orderId, paymentId, amountCents }: Attempt,
  result: ChargeResult,
): Promise<PayResult> {
  const orderStatus = await withTransaction(async (db) => {
    await db.query(
      `UPDATE payments SET status = 'failed', resolved_at = NOW() WHERE store_id = $1 AND id = $2`,
      [storeId, paymentId],
    );
    // Same guard as the success path: release the reservation once, and only
    // when this call is the one that closed the order.
    const { rowCount } = await db.query(
      `UPDATE orders SET status = 'failed', updated_at = NOW()
        WHERE store_id = $1 AND id = $2 AND status = 'confirmed'`,
      [storeId, orderId],
    );
    if (rowCount === 1) {
      await releaseReservations(db, storeId, orderId);
      return 'failed';
    }
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM orders WHERE store_id = $1 AND id = $2`,
      [storeId, orderId],
    );
    return rows[0]?.status ?? 'unknown';
  }, { retries: 20 });

  return {
    storeId,
    orderId,
    paymentId,
    status: 'failed',
    orderStatus,
    amountCents,
    ...(result.declineReason !== undefined ? { declineReason: result.declineReason } : {}),
  };
}

/**
 * ADR-003's unknown state. Poll every 2s for up to 30s.
 *
 * Stock stays reserved throughout and stays reserved if it never resolves:
 * releasing it could oversell an item the customer did in fact pay for. The
 * order remains 'confirmed', which the expiry reaper skips, so only a human
 * reconciling the payment can free it. `GET /v1/stores/:storeId/health/orders`
 * lists these.
 */
async function reconcileUnknown(attempt: Attempt, idempotencyKey: string): Promise<PayResult> {
  const { storeId, orderId, paymentId, amountCents } = attempt;
  await pool.query(`UPDATE payments SET status = 'unknown' WHERE store_id = $1 AND id = $2`, [
    storeId,
    paymentId,
  ]);

  const deadline = Date.now() + config.paymentPollTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(config.paymentPollIntervalMs);
    const polled = await terminal.getStatus(idempotencyKey);
    // 'not_found' this soon after charging most likely means the gateway has
    // not written the record yet, so keep asking rather than concluding.
    if (polled.status === 'succeeded' || polled.status === 'failed') {
      return applyOutcome(attempt, { ...polled, status: polled.status });
    }
  }

  // Never assume success, never assume failure.
  return {
    storeId,
    orderId,
    paymentId,
    status: 'unknown',
    orderStatus: 'confirmed',
    amountCents,
    supportReference: orderId,
  };
}
