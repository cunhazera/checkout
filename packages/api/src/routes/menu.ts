import type { FastifyInstance } from 'fastify';
import { getMenu } from '../services/menu.service.js';
import { storeParams } from './schemas.js';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  app.get('/menu', { schema: { params: storeParams } }, async (req) => ({
    storeId: req.store.id,
    // Prices mean nothing without their currency once stores span countries.
    currency: req.store.currency,
    items: await getMenu(req.store.id),
  }));
}
