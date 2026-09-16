/**
 * ADR-005: cents stay integers everywhere. This module is the ONLY place a
 * division by 100 is allowed — it is the UI rendering layer the ADR describes.
 */

let currency = 'USD';
let locale = 'en-US';

export function configureMoney(next: { currency: string; locale: string }): void {
  currency = next.currency;
  locale = next.locale;
}

export function formatCents(value: number): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100);
}

/**
 * Display-only tax estimate for the basket screen, before an order exists.
 * Mirrors the server's `taxOn`. Once the order is created, the server's
 * subtotal/tax/total replace this — the client never decides what is owed.
 */
export function estimateTax(subtotalCents: number, basisPoints: number): number {
  return Math.round((subtotalCents * basisPoints) / 10_000);
}
