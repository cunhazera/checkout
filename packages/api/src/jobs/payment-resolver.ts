import { pool, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { applyOutcome, getTerminal, type Attempt } from '../services/payment.service.js';

/**
 * Finishes payment attempts that nobody else will.
 *
 * `payOrder` records its intent — the order claimed as 'confirmed' and a
 * payments row with its idempotency key — in one transaction *before* calling
 * the gateway. That ordering means a crash can never lose the fact that a
 * charge might exist. But recording intent is only half of the pattern: without
 * something that comes back and finishes the job, a process killed mid-charge
 * leaves the order 'confirmed', the stock reserved, and the customer possibly
 * charged, forever. The expiry reaper deliberately will not touch those orders,
 * because releasing a paid order's stock would oversell it.
 *
 * This is the other half. It asks the gateway what actually happened, using the
 * key that was stored before the call, and then settles or releases.
 *
 * Deleting the records instead would be wrong: once a request may have reached
 * the gateway, our row is the only evidence that money moved.
 */

export interface ResolverOptions {
  /** Ignore attempts younger than this, so the resolver never races a live request. */
  graceMs?: number;
  /** Stop asking after this many tries and leave it for a person. */
  maxAttempts?: number;
  /** Rows per sweep. */
  batchSize?: number;
}

export interface ResolverResult {
  checked: number;
  settled: number;
  stillUnknown: number;
  exhausted: number;
}

interface StuckPayment {
  store_id: string;
  id: string;
  order_id: string;
  amount_cents: number;
  idempotency_key: string;
  resolve_attempts: number;
}

export async function runPaymentResolver(
  log: (msg: string) => void = console.log,
  opts: ResolverOptions = {},
): Promise<ResolverResult> {
  const graceMs = opts.graceMs ?? config.paymentResolveGraceMs;
  const maxAttempts = opts.maxAttempts ?? config.paymentResolveMaxAttempts;
  const batchSize = opts.batchSize ?? 50;

  // SKIP LOCKED so several API instances can run this at once without two of
  // them resolving the same attempt. Claiming the rows (bumping the attempt
  // counter) and querying the gateway are separate steps: the gateway call must
  // never happen inside a transaction.
  const claimed = await withTransaction(async (db) => {
    const { rows } = await db.query<StuckPayment>(
      `SELECT store_id, id, order_id, amount_cents, idempotency_key, resolve_attempts
         FROM payments
        WHERE status IN ('pending', 'unknown')
          AND created_at < NOW() - ($1 || ' milliseconds')::interval
          AND resolve_attempts < $2
        ORDER BY created_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [String(graceMs), maxAttempts, batchSize],
    );

    if (rows.length > 0) {
      await db.query(
        `UPDATE payments
            SET resolve_attempts = resolve_attempts + 1, last_attempt_at = NOW()
          WHERE (store_id, id) IN (
            SELECT * FROM unnest($1::uuid[], $2::uuid[])
          )`,
        [rows.map((r) => r.store_id), rows.map((r) => r.id)],
      );
    }
    return rows;
  });

  const result: ResolverResult = {
    checked: claimed.length,
    settled: 0,
    stillUnknown: 0,
    exhausted: 0,
  };

  for (const row of claimed) {
    const attempt: Attempt = {
      storeId: row.store_id,
      orderId: row.order_id,
      paymentId: row.id,
      amountCents: row.amount_cents,
    };

    let outcome;
    try {
      outcome = await getTerminal().getStatus(row.idempotency_key);
    } catch (err) {
      // Asking failed; the attempt keeps its place in the queue for next time.
      log(`payment ${row.id}: could not reach the gateway (${String(err)})`);
      result.stillUnknown += 1;
      continue;
    }

    if (outcome.status === 'not_found') {
      // Past the grace period the gateway would have recorded the charge if it
      // had accepted one. No record means no money moved, so the reservation
      // can go back on the shelf instead of being frozen for a person.
      const released = await applyOutcome(attempt, {
        status: 'failed',
        declineReason: 'never_reached_gateway',
      });
      result.settled += 1;
      log(
        `payment ${row.id} (order ${row.order_id}) never reached the gateway; ` +
          `order is now ${released.orderStatus}`,
      );
      continue;
    }

    if (outcome.status === 'unknown') {
      result.stillUnknown += 1;
      if (row.resolve_attempts + 1 >= maxAttempts) {
        result.exhausted += 1;
        // Loud on purpose: money may have moved and no automated step is left.
        log(
          `payment ${row.id} (order ${row.order_id}) is still unresolved after ` +
            `${maxAttempts} attempts — needs a human`,
        );
      }
      continue;
    }

    const settledTo = await applyOutcome(attempt, {
      ...outcome,
      status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
    });
    result.settled += 1;
    log(
      `payment ${row.id} (order ${row.order_id}) resolved as ${outcome.status}; ` +
        `order is now ${settledTo.orderStatus}`,
    );
  }

  return result;
}

export interface ResolverHandle {
  stop(): Promise<void>;
}

export function startPaymentResolver(
  log?: (msg: string) => void,
  intervalMs: number = config.paymentResolveIntervalMs,
): ResolverHandle {
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    // A sweep that outlives its interval must not overlap itself.
    if (inFlight) return;
    inFlight = runPaymentResolver(log)
      .then((r) => {
        if (r.checked > 0) {
          log?.(
            `payment resolver: checked ${r.checked}, settled ${r.settled}, ` +
              `still unknown ${r.stillUnknown}, exhausted ${r.exhausted}`,
          );
        }
      })
      .catch((err) => console.error('payment resolver failed', err))
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);

  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
