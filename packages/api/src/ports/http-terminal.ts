import { config } from '../config.js';
import type { ChargeRequest, ChargeResult, PaymentTerminal, StatusResult } from './payment-terminal.js';

/**
 * Talks to a payment gateway over HTTP.
 *
 * The whole job of this class is turning the many ways an HTTP call can go
 * wrong into exactly three answers: succeeded, failed, or unknown. ADR-003 is
 * strict about the third — "we do not know" must never be rounded to either of
 * the others, because one loses money and the other sells goods for free.
 *
 * The rule it applies: **did the request definitely never reach the gateway?**
 *   - Connection refused or DNS failure: nothing was charged → failed, retryable.
 *   - Timeout, connection reset, 5xx, unreadable body: it may have been charged
 *     → unknown, and the caller polls getStatus until the gateway tells us.
 */
export class HttpTerminal implements PaymentTerminal {
  constructor(
    private readonly baseUrl: string = config.paymentGatewayUrl,
    private readonly timeoutMs: number = config.paymentHttpTimeoutMs,
    private readonly retries: number = config.paymentHttpRetries,
  ) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    let sawPossibleCharge = false;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/charges`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The key makes retrying safe: the gateway returns the original
          // charge rather than creating a second one.
          body: JSON.stringify({
            idempotencyKey: req.idempotencyKey,
            amountCents: req.amountCents,
            currency: req.currency,
            method: req.method,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (isTimeout(err)) {
          // The gateway may be settling this charge right now. Do not retry:
          // the caller's reconciliation loop is the right place to find out.
          return { status: 'unknown' };
        }
        if (!isUnreachable(err)) sawPossibleCharge = true;
        continue; // retry network errors
      }

      if (res.status === 429 || res.status >= 500) {
        sawPossibleCharge = true;
        continue;
      }

      if (res.status >= 400) {
        // The gateway understood and rejected the request, so nothing was
        // charged. Not a card decline, but still a definite failure.
        const body = await safeJson(res);
        return { status: 'failed', declineReason: str(body?.error) ?? 'gateway_rejected' };
      }

      const body = await safeJson(res);
      const status = str(body?.status);
      if (status === 'approved') {
        return { status: 'succeeded', ...idOf(body) };
      }
      if (status === 'declined') {
        return { status: 'failed', declineReason: str(body?.declineCode) ?? 'card_declined' };
      }
      // 200, but not an answer we understand — including a charge the gateway
      // still calls 'pending'. Treat it as not knowing.
      return { status: 'unknown' };
    }

    // Every attempt failed at the network level.
    if (!sawPossibleCharge) {
      // Only ever connection-refused style errors: the gateway was never
      // reached, so no money moved and the customer can safely retry.
      return { status: 'failed', declineReason: 'gateway_unreachable' };
    }
    // Something might have got through. Ask before assuming.
    const probe = await this.getStatus(req.idempotencyKey);
    if (probe.status === 'not_found') {
      // The gateway has no record, but we only just stopped retrying — it may
      // still be writing one. The resolver asks again after a grace period,
      // which is when absence can safely be read as "never charged".
      return { status: 'unknown' };
    }
    return { ...probe, status: probe.status };
  }

  async getStatus(idempotencyKey: string): Promise<StatusResult> {
    try {
      const res = await fetch(`${this.baseUrl}/charges/${encodeURIComponent(idempotencyKey)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        // No record of the key. The caller decides what to make of it: during
        // live polling it may simply not be written yet, while the resolver
        // only asks after a grace period and can treat it as "never charged".
        return { status: 'not_found' };
      }
      if (!res.ok) return { status: 'unknown' };

      const body = await safeJson(res);
      const status = str(body?.status);
      if (status === 'approved') return { status: 'succeeded', ...idOf(body) };
      if (status === 'declined') {
        return { status: 'failed', declineReason: str(body?.declineCode) ?? 'card_declined' };
      }
      return { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential with full jitter, so retries from several totems do not line up. */
const backoffMs = (attempt: number) => Math.random() * Math.min(2 ** (attempt - 1) * 200, 2_000);

const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * True when the request provably never left this machine, so nothing can have
 * been charged.
 *
 * fetch wraps the real cause, and when a host resolves to several addresses the
 * cause is an AggregateError holding one error per attempt — so the code can be
 * one level deeper than expected.
 */
function isUnreachable(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause;
  const codes = [
    (err as { code?: string })?.code,
    (cause as { code?: string })?.code,
    ...((cause as { errors?: { code?: string }[] })?.errors ?? []).map((e) => e?.code),
  ];
  return codes.some((c) => c !== undefined && UNREACHABLE_CODES.has(c));
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const idOf = (body: Record<string, unknown> | null) => {
  const id = str(body?.chargeId);
  return id === undefined ? {} : { providerPaymentId: id };
};
