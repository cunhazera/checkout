/**
 * The hardware boundary. Every provider-specific detail lives behind this
 * interface, so the payment state machine is developed and tested against the
 * fake driver and the real SDK drops in without touching payment.service.ts.
 */

export type PaymentMethod = 'card' | 'wallet' | 'qr';
export type TerminalOutcome = 'succeeded' | 'failed' | 'unknown';

export interface ChargeRequest {
  amountCents: number;
  /** ISO 4217, from the store. An amount without a currency is meaningless. */
  currency: string;
  method: PaymentMethod;
  idempotencyKey: string;
}

export interface ChargeResult {
  status: TerminalOutcome;
  providerPaymentId?: string;
  /** Present on 'failed' — surfaced to the totem for the decline message. */
  declineReason?: string;
}

/**
 * What a lookup can say, which is one more thing than a charge can.
 *
 * 'not_found' means the gateway has no record of this idempotency key at all.
 * That is genuinely different from 'unknown': a gateway records a charge when
 * it accepts one, so no record means no money moved, and the reservation can be
 * released rather than frozen for a human. Only trust it after a grace period —
 * immediately after a request, absence may just mean "not written yet".
 */
export interface StatusResult {
  status: TerminalOutcome | 'not_found';
  providerPaymentId?: string;
  declineReason?: string;
}

export interface PaymentTerminal {
  /** Resolves with 'unknown' on timeout — it must never throw for a timeout,
   *  since "we don't know" is a real outcome that ADR-003 handles explicitly. */
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /** Polled while an outcome is unknown, and by the payment resolver. */
  getStatus(idempotencyKey: string): Promise<StatusResult>;
}
