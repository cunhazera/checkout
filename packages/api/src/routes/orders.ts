import type { FastifyInstance } from 'fastify';
import { cancelOrder, createOrder, getOrder } from '../services/order.service.js';
import { payOrder } from '../services/payment.service.js';
import type { PaymentMethod } from '../ports/payment-terminal.js';
import { createOrderBody, createPaymentBody, storeOrderParams, storeParams } from './schemas.js';

interface CreateOrderBody {
  sessionId: string;
  totemId: string;
  items: { itemId: string; quantity: number }[];
}

interface CreatePaymentBody {
  method?: PaymentMethod;
}

type OrderParams = { storeId: string; orderId: string };

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateOrderBody }>(
    '/orders',
    { schema: { params: storeParams, body: createOrderBody } },
    async (req, reply) => {
      const order = await createOrder(req.store.id, req.body);
      reply.code(201);
      return order;
    },
  );

  app.get<{ Params: OrderParams }>(
    '/orders/:orderId',
    { schema: { params: storeOrderParams } },
    async (req) => getOrder(req.store.id, req.params.orderId),
  );

  /**
   * Each call creates a payment attempt, so this is POST on a payments
   * collection and answers 201 whatever the outcome — `status` in the body says
   * whether it succeeded, failed, or is unknown.
   *
   * ADR-003 resolves the payment inside the request, and the unknown-state
   * window alone is 30s; app.ts disables the server request timeout for that.
   */
  app.post<{ Params: OrderParams; Body: CreatePaymentBody }>(
    '/orders/:orderId/payments',
    {
      schema: { params: storeOrderParams, body: createPaymentBody },
      // The body is optional (method defaults to card), but a body schema
      // rejects a missing body outright. Default it before validation runs.
      preValidation: async (req) => {
        req.body ??= {};
      },
    },
    async (req, reply) => {
      const result = await payOrder(req.store.id, req.params.orderId, req.body.method ?? 'card');
      reply.code(201);
      return result;
    },
  );

  /**
   * Orders are financial records and are never deleted, so cancelling is an
   * action on the order rather than DELETE. Idempotent.
   */
  app.post<{ Params: OrderParams }>(
    '/orders/:orderId/cancel',
    { schema: { params: storeOrderParams } },
    async (req) => cancelOrder(req.store.id, req.params.orderId),
  );
}
