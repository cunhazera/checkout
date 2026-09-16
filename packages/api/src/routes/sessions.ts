import type { FastifyInstance } from 'fastify';
import { startSession } from '../services/order.service.js';
import { storeParams } from './schemas.js';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sessions', { schema: { params: storeParams } }, async (req, reply) => {
    reply.code(201);
    return startSession(req.store.id);
  });
}
