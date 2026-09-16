/**
 * Request schemas. Fastify validates these before any handler or hook runs, so
 * malformed input is a 400 at the edge instead of an error from Postgres.
 *
 * Every object sets `additionalProperties: false`: with Fastify's default
 * `removeAdditional: true` that silently drops unknown fields rather than
 * passing them through to the services.
 *
 * Every store-scoped route MUST declare params that include storeId. The store
 * hook reads it after validation; an unvalidated id would reach Postgres.
 */

const uuid = { type: 'string', format: 'uuid' } as const;

export const storeParams = {
  type: 'object',
  required: ['storeId'],
  additionalProperties: false,
  properties: { storeId: uuid },
} as const;

export const storeOrderParams = {
  type: 'object',
  required: ['storeId', 'orderId'],
  additionalProperties: false,
  properties: { storeId: uuid, orderId: uuid },
} as const;

export const createOrderBody = {
  type: 'object',
  required: ['sessionId', 'totemId', 'items'],
  additionalProperties: false,
  properties: {
    // orders.session_id is VARCHAR(255); longer values failed in the INSERT.
    sessionId: { type: 'string', minLength: 1, maxLength: 255 },
    totemId: uuid,
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['itemId', 'quantity'],
        additionalProperties: false,
        properties: {
          itemId: uuid,
          quantity: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

export const createPaymentBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', enum: ['card', 'wallet', 'qr'] },
  },
} as const;
