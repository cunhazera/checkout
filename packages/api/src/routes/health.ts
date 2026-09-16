import type { FastifyInstance } from 'fastify';
import { pool, poolStats } from '../db/pool.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness for the process and its database. Store-level probes live under
  // /v1/stores/:storeId/health.
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    // `waiting` above zero means requests are queueing for a connection: the
    // first thing to look at when the API is slow but the database is not.
    return { status: 'ok', pool: poolStats() };
  });
}
