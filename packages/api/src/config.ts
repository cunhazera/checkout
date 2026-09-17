/** Environment parsing. Fails fast and loudly at startup rather than at 2am. */

const str = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
};

const int = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Env var ${key} must be an integer, got "${raw}"`);
  return n;
};

const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Env var ${key} must be one of ${allowed.join(' | ')}, got "${raw}"`);
  }
  return raw as T;
};

export const FAKE_MODES = ['approve', 'decline', 'timeout', 'timeout_then_approve'] as const;
export type FakeTerminalMode = (typeof FAKE_MODES)[number];

export const config = {
  databaseUrl: str('DATABASE_URL', 'postgres://checkout:checkout@localhost:5433/checkout'),
  // 3210, not 3000: port 3000 is commonly taken (Grafana, other dev servers)
  // and the totem's Vite proxy targets this value by default.
  port: int('PORT', 3210),
  /** Loopback only — ADR-002 removes auth, which is sound only while the totem's
   *  own browser is the sole client. Binding 0.0.0.0 would open the door. */
  host: str('HOST', '127.0.0.1'),
  orderTtlMinutes: int('ORDER_TTL_MINUTES', 15),
  paymentDriver: oneOf('PAYMENT_DRIVER', ['fake', 'http', 'stripe', 'sumup'] as const, 'fake'),
  /** Where the 'http' driver sends charges (the mock gateway in development). */
  paymentGatewayUrl: str('PAYMENT_GATEWAY_URL', 'http://127.0.0.1:3220'),
  /** Per-attempt HTTP timeout. Past this the outcome is unknown, not failed. */
  paymentHttpTimeoutMs: int('PAYMENT_HTTP_TIMEOUT_MS', 15_000),
  /** Retries after the first attempt, for network errors, 5xx and 429. */
  paymentHttpRetries: int('PAYMENT_HTTP_RETRIES', 2),
  /** How often the resolver sweeps for payments that never finished. */
  paymentResolveIntervalMs: int('PAYMENT_RESOLVE_INTERVAL_MS', 30_000),
  /** Left alone for this long first, so it never races a live request. */
  paymentResolveGraceMs: int('PAYMENT_RESOLVE_GRACE_MS', 60_000),
  /** After this many attempts, stop asking and leave it for a human. */
  paymentResolveMaxAttempts: int('PAYMENT_RESOLVE_MAX_ATTEMPTS', 10),
  fakeTerminalMode: oneOf('FAKE_TERMINAL_MODE', FAKE_MODES, 'approve'),
  paymentPollIntervalMs: int('PAYMENT_POLL_INTERVAL_MS', 2_000),
  paymentPollTimeoutMs: int('PAYMENT_POLL_TIMEOUT_MS', 30_000),

  // --- database pool -------------------------------------------------------
  /**
   * Connections per API instance. The number that matters is
   * instances x DB_POOL_MAX <= Postgres max_connections (default 100) minus
   * headroom for admin and jobs. Past a handful of instances, put PgBouncer in
   * front rather than raising this: idle Postgres backends cost memory whether
   * or not they are working.
   */
  dbPoolMax: int('DB_POOL_MAX', 20),
  dbIdleTimeoutMs: int('DB_IDLE_TIMEOUT_MS', 30_000),
  /** Wait for a free connection, then fail fast instead of queueing forever. */
  dbConnectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', 5_000),
  /** No statement in this system is legitimately slow; a stuck one starves the pool. */
  dbStatementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 10_000),
  /** A transaction left open holds locks. Nothing here awaits the network inside one. */
  dbIdleInTransactionTimeoutMs: int('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 15_000),
  /** Recycle connections so a restarted or rebalanced database is picked up. */
  dbMaxLifetimeSeconds: int('DB_MAX_LIFETIME_SECONDS', 1_800),
  /** Store details (currency, tax, active flag) change rarely. A deactivated
   *  store keeps selling for at most this long on an instance that cached it. */
  storeCacheMs: int('STORE_CACHE_MS', 30_000),
} as const;
