import { describe, it, expect } from 'vitest';
import { configureMoney, estimateTax, formatCents } from './money';

describe('money formatting', () => {
  it('formats in the store currency and locale', () => {
    configureMoney({ currency: 'USD', locale: 'en-US' });
    expect(formatCents(240)).toBe('$2.40');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123456)).toBe('$1,234.56');
  });

  it('formats a Brazilian store in reais', () => {
    configureMoney({ currency: 'BRL', locale: 'pt-BR' });
    // Non-breaking space between symbol and amount, comma as the decimal mark.
    expect(formatCents(1290).replace(/ /g, ' ')).toBe('R$ 12,90');
    configureMoney({ currency: 'USD', locale: 'en-US' });
  });

  it('estimates tax the same way the server computes it', () => {
    expect(estimateTax(0, 800)).toBe(0);
    expect(estimateTax(1000, 800)).toBe(80);
    expect(estimateTax(240, 800)).toBe(19); // 19.2 rounds to 19, once
    expect(estimateTax(1299, 0)).toBe(0);
  });
});
