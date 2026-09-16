/**
 * ADR-005: all monetary values are integer centavos. Never NUMERIC, never float.
 *
 * `Cents` is a branded type: it compiles to a plain number (zero runtime cost)
 * but cannot be passed where a count is expected, or vice versa. Conversion to
 * display format happens only in the UI layer — never here, never in SQL.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) throw new Error(`Cents must be an integer, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new Error(`Cents out of safe integer range: ${n}`);
  return n as Cents;
};

export const ZERO = cents(0);

export const addCents = (a: Cents, b: Cents): Cents => cents(a + b);

export const multiplyCents = (unit: Cents, quantity: number): Cents => {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return cents(unit * quantity);
};

export const sumCents = (values: readonly Cents[]): Cents => values.reduce(addCents, ZERO);

/**
 * Tax on a subtotal, in basis points (800 bp = 8%). Rounds half-up once, at the
 * end — the design's prototype multiplied floats, which is exactly the rounding
 * drift ADR-005 exists to prevent.
 */
export const taxOn = (subtotal: Cents, basisPoints: number): Cents => {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error(`Tax basis points must be a non-negative integer, got ${basisPoints}`);
  }
  return cents(Math.round((subtotal * basisPoints) / 10_000));
};
