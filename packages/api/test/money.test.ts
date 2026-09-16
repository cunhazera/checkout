import { describe, it, expect } from 'vitest';
import { addCents, cents, multiplyCents, sumCents, taxOn } from '../src/money.js';

describe('money (ADR-005)', () => {
  it('rejects non-integer values', () => {
    expect(() => cents(1.5)).toThrow(/integer/);
  });

  it('rejects values beyond safe integer range', () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it('adds and multiplies exactly', () => {
    expect(addCents(cents(150), cents(1299))).toBe(1449);
    expect(multiplyCents(cents(240), 3)).toBe(720);
    expect(sumCents([cents(240), cents(390), cents(180)])).toBe(810);
  });

  it('avoids the float drift the prototype had', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in cents it is exact.
    expect(addCents(cents(10), cents(20))).toBe(30);
  });

  it('rejects negative or fractional quantities', () => {
    expect(() => multiplyCents(cents(100), -1)).toThrow();
    expect(() => multiplyCents(cents(100), 1.5)).toThrow();
  });

  it('computes tax in basis points, rounding once', () => {
    expect(taxOn(cents(0), 800)).toBe(0);
    expect(taxOn(cents(1000), 800)).toBe(80);
    // 2.40 * 8% = 19.2 cents -> 19
    expect(taxOn(cents(240), 800)).toBe(19);
    // Tax disabled by default
    expect(taxOn(cents(1299), 0)).toBe(0);
  });
});
