import pg from 'pg';
import { config } from '../config.js';
import { databaseBusy } from '../errors.js';
import { registerTypeParsers } from './types.js';

registerTypeParsers();

/**
 * One pool per API instance.
 *
 * Sizing is not "bigger is better": every connection is a Postgres backend
 * holding memory whether it is working or not, so the ceiling that matters is
 * instances x DB_POOL_MAX against the server's max_connections. Transactions
 * here are milliseconds long and never wait on the network — the gateway call
 * deliberately happens between transactions — so a modest pool sustains a lot
 * of orders. Scale out with more instances plus PgBouncer, not a huge pool.
 *
 * Under sharding this becomes one pool per shard, keyed the same way as
 * everything else (see DISTRIBUTED_ARCHITECTURE.md).
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  // Without this, a request that finds the pool exhausted waits forever: the
  // queue grows silently and the totem shows a spinner instead of an error.
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  // Guard rails applied to every session. A query that hangs would otherwise
  // hold its connection indefinitely and take the pool down with it.
  statement_timeout: config.dbStatementTimeoutMs,
  idle_in_transaction_session_timeout: config.dbIdleInTransactionTimeoutMs,
  // Recycles connections, so a failover or a rebalanced pooler is picked up.
  maxLifetimeSeconds: config.dbMaxLifetimeSeconds,
  keepAlive: true,
  // Names the connections in pg_stat_activity, which is how you tell which of
  // many instances is holding what.
  application_name: 'checkout-api',
});

/**
 * An idle connection can fail on its own — a database restart, a dropped
 * network link, a pooler recycling. Postgres emits that on the pool, and an
 * unhandled 'error' event takes the whole process down. The pool discards the
 * bad connection by itself; this only stops the crash.
 */
pool.on('error', (err) => {
  console.error('idle database connection failed', err);
});

export type Db = pg.PoolClient;

/** Snapshot for health checks: `waiting > 0` means the pool is the bottleneck. */
export const poolStats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  max: config.dbPoolMax,
});

/** Postgres SQLSTATEs that mean "retry the whole transaction". */
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

const isRetryable = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full jitter: a random slice of an exponentially growing window. Fixed backoff
 * would let the whole contending set wake together and collide again — the
 * classic thundering herd.
 */
const fullJitter = (attempt: number) => Math.random() * Math.min(2 ** (attempt - 1) * 5, 150);

/** Observability: how often contention actually forced a replay. */
let retryCount = 0;
export const getTransactionRetryCount = (): number => retryCount;
export const resetTransactionRetryCount = (): void => {
  retryCount = 0;
};

/**
 * Takes a connection, turning pool exhaustion into a 503 the totem can explain
 * rather than an opaque timeout. Shedding load beats an unbounded queue: the
 * customer can tap again, but a queue of requests older than their sessions
 * helps nobody.
 */
export async function acquire(from: pg.Pool = pool): Promise<Db> {
  try {
    return await from.connect();
  } catch (err) {
    if (err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message)) {
      throw databaseBusy();
    }
    throw err;
  }
}

export interface TransactionOptions {
  /**
   * Replays after a serialization failure or deadlock. Default 10.
   *
   * SERIALIZABLE aborts contending transactions rather than queuing them, so
   * the budget has to cover the worst realistic pile-up. The deadlock test
   * deliberately drives 12 carts at the same two rows; at 5 retries a handful
   * of those still exhausted the budget and surfaced a raw 40001 to a customer.
   */
  retries?: number;
  onRetry?: (attempt: number, err: unknown) => void;
  /** Tests use this to drive a pool of their own. */
  pool?: pg.Pool;
  /** Overrides the backoff, so a test can make the wait deterministic. */
  backoffMs?: (attempt: number) => number;
}

/**
 * Runs `fn` in a SERIALIZABLE transaction, committing on return and rolling
 * back on throw.
 *
 * SERIALIZABLE makes Postgres guarantee the outcome matches *some* serial
 * order of the concurrent transactions, covering rows this code never thought
 * to lock — correctness no longer depends on remembering a FOR UPDATE.
 *
 * The price is that contention aborts a transaction (SQLSTATE 40001) instead of
 * blocking it, so every caller needs a retry. That retry lives here rather than
 * in each service, and it is safe because a rolled-back transaction leaves no
 * partial effect: replaying `fn` re-reads fresh state and applies its writes
 * exactly once.
 *
 * `fn` MUST therefore be free of side effects outside this transaction — no
 * card charges, no printing. The payment flow already calls the gateway
 * between transactions, never inside one, for exactly this reason.
 *
 * The explicit FOR UPDATE locks are kept: they turn most contention into a
 * brief wait rather than an abort-and-replay, so retries stay rare.
 */
export async function withTransaction<T>(
  fn: (db: Db) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const from = opts.pool ?? pool;
  const maxAttempts = (opts.retries ?? 10) + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await acquire(from);
    let retryIn: number | null = null;

    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        /* connection already broken; the original error is the interesting one */
      });

      if (!isRetryable(err)) throw err;
      if (attempt === maxAttempts) {
        // Out of retry budget. This is contention, not a defect: reporting it
        // as 503 tells the totem to try again instead of showing the customer
        // an error that reads like a broken checkout.
        console.warn('transaction gave up after contention', { attempts: maxAttempts, err });
        throw databaseBusy('contention');
      }

      lastError = err;
      retryCount += 1;
      opts.onRetry?.(attempt, err);
      retryIn = (opts.backoffMs ?? fullJitter)(attempt);
    } finally {
      client.release();
    }

    // Deliberately outside the try/finally: waiting here while still holding a
    // connection would starve the pool exactly when contention is highest.
    // Measured at 4 connections: an unrelated query waited 55ms when the sleep
    // held the client, and 2ms once it did not.
    if (retryIn !== null) await sleep(retryIn);
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
