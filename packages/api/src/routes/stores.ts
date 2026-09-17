import type { FastifyInstance } from 'fastify';
import { getStore, type Store } from '../services/store.service.js';
import { storeInfoRoutes } from './store-info.js';
import { menuRoutes } from './menu.js';
import { orderRoutes } from './orders.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The active store addressed by :storeId. Set for every store-scoped route. */
    store: Store;
  }
}

/**
 * Everything a totem does happens inside one store, so every such route lives
 * under /v1/stores/:storeId and resolves the store once, here.
 *
 * Fastify encapsulation keeps this hook and decorator to the routes registered
 * inside this plugin; /health and anything global stay outside it.
 *
 * The store id in the path is also the routing key a gateway will use later to
 * send a request to the right shard, and the key for per-store caching.
 */
export async function storeScope(app: FastifyInstance): Promise<void> {
  app.decorateRequest('store', null as unknown as Store);

  // preHandler runs after schema validation, so storeId is already a UUID here.
  app.addHook('preHandler', async (req) => {
    const { storeId } = req.params as { storeId: string };
    req.store = await getStore(storeId);
  });

  await app.register(storeInfoRoutes);
  await app.register(menuRoutes);
  await app.register(orderRoutes);
}
