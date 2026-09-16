import pg from 'pg';

/**
 * node-postgres returns BIGINT (int8) as a *string*, because 2^63 does not fit
 * in a JS number. ADR-005 stores every monetary value as BIGINT cents, so
 * without this parser every price arrives as "150" instead of 150 and string
 * concatenation silently replaces addition.
 *
 * The safe-integer guard turns any genuine overflow into a loud crash rather
 * than silent corruption. MAX_SAFE_INTEGER is ~9e15 cents = R$ 90 trillion.
 */
export function registerTypeParsers(): void {
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`int8 value out of safe integer range: ${value}`);
    }
    return n;
  });
}
