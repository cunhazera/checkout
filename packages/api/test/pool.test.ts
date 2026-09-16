import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { acquire, closePool, pool, poolStats, withTransaction } from '../src/db/pool.js';
import { setupDatabase } from './helpers.js';

beforeAll(setupDatabase);
afterAll(closePool);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = () => Object.assign(new Error('could not serialize access'), { code: '40001' });

/** A pool of our own, so exhaustion can be produced without touching the real one. */
const tinyPool = (max: number, connectionTimeoutMillis = 300) =>
  new pg.Pool({ connectionString: config.databaseUrl, max, connectionTimeoutMillis });

describe('connection pool guard rails', () => {
  it('applies statement and idle-in-transaction timeouts to every session', async () => {
    // Without these a single stuck query holds its connection forever and the
    // pool drains one slot at a time.
    const settings = await withTransaction(async (db) => {
      const { rows } = await db.query<{ name: string; setting: string }>(
        `SELECT name, setting FROM pg_settings
          WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')
          ORDER BY name`,
      );
      return Object.fromEntries(rows.map((r) => [r.name, r.setting]));
    });

    expect(settings['idle_in_transaction_session_timeout']).toBe(
      String(config.dbIdleInTransactionTimeoutMs),
    );
    expect(settings['statement_timeout']).toBe(String(config.dbStatementTimeoutMs));
  });

  it('kills a statement that overruns instead of holding the connection', async () => {
    await expect(
      withTransaction(async (db) => {
        await db.query(`SET LOCAL statement_timeout = '200ms'`);
        await db.query('SELECT pg_sleep(2)');
      }),
    ).rejects.toMatchObject({ code: '57014' }); // query_canceled
  });

  it('survives an idle connection failing on its own', async () => {
    // An unhandled 'error' event on the pool takes the process down with it.
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('connection reset by peer'))).not.toThrow();
  });

  it('reports what the pool is doing', async () => {
    const stats = poolStats();
    expect(stats.max).toBe(config.dbPoolMax);
    expect(stats.waiting).toBe(0);
  });
});

describe('pool exhaustion', () => {
  it('sheds load with a 503 instead of queueing forever', async () => {
    const small = tinyPool(1);
    const held = await small.connect(); // the only connection

    const started = Date.now();
    await expect(acquire(small)).rejects.toMatchObject({
      statusCode: 503,
      code: 'database_busy',
    });
    // Fast and bounded: the old behaviour was to wait indefinitely.
    expect(Date.now() - started).toBeLessThan(2_000);

    held.release();
    await small.end();
  });

  it('serves the next request once a connection frees up', async () => {
    const small = tinyPool(1);
    const held = await small.connect();
    setTimeout(() => held.release(), 100);

    const value = await withTransaction(async (db) => (await db.query('SELECT 42 AS n')).rows[0].n, {
      pool: small,
    });

    expect(value).toBe(42);
    await small.end();
  });
});

describe('losing the retry budget', () => {
  it('reports contention as a retryable 503, not a server error', async () => {
    // A customer whose transaction lost every round should be told to try
    // again, not shown a 500 that looks like the checkout is broken.
    await expect(
      withTransaction(
        async () => {
          throw retryable();
        },
        { retries: 1, backoffMs: () => 0 },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'database_busy',
      details: { reason: 'contention' },
    });
  });
});

describe('retry backoff', () => {
  it('does not hold a connection while waiting to retry', async () => {
    // The bug this guards: with release() inside `finally`, the backoff sleep
    // happened while still holding the client, so contention starved every
    // other query. Measured at 55ms versus 2ms on a pool of four.
    const small = tinyPool(2, 2_000);
    await small.query('SELECT 1');

    // Saturate the pool with transactions that keep failing and backing off.
    // The backoff is fixed here so the measurement is about who holds the
    // connection, not about how the jitter happened to land.
    const contending = Array.from({ length: 2 }, () =>
      withTransaction(
        async () => {
          throw retryable();
        },
        { pool: small, retries: 6, backoffMs: () => 100 },
      ).catch(() => undefined),
    );

    await sleep(30);
    const started = Date.now();
    await small.query('SELECT 1'); // an ordinary read, like a menu request
    const waited = Date.now() - started;

    await Promise.all(contending);
    await small.end();

    expect(waited).toBeLessThan(50);
  });
});
