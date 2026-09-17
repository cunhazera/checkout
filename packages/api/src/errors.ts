/**
 * Errors carry a stable machine-readable `code`. The design handoff requires a
 * specific UI message per failure (its edge-case table), so the totem keys its
 * copy off these codes rather than parsing prose.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const outOfStock = (productId: string, productName: string, available: number) =>
  new AppError(409, 'product_out_of_stock', `${productName} is no longer available`, {
    productId,
    productName,
    available,
  });

export const storeNotFound = (storeId: string) =>
  new AppError(404, 'store_not_found', 'Store not found', { storeId });

export const totemNotFound = (totemId: string) =>
  new AppError(400, 'totem_not_found', 'Totem is not registered to this store', { totemId });

export const orderNotFound = (orderId: string) =>
  new AppError(404, 'order_not_found', 'Order not found', { orderId });

export const orderNotPending = (orderId: string, status: string) =>
  new AppError(409, 'order_not_pending', `Order is ${status}, not pending`, { orderId, status });

export const orderExpired = (orderId: string) =>
  new AppError(410, 'order_expired', 'This order has expired', { orderId });

export const productUnavailable = (productId: string) =>
  new AppError(400, 'product_unavailable', 'This store does not sell that product', { productId });

/**
 * Too busy to serve this request right now, for one of two reasons: no free
 * connection in time, or a transaction that lost its retry budget to
 * contention. Both are transient and safe for the customer to retry, which is
 * why they are 503 rather than a 500 that reads like a bug.
 */
export const databaseBusy = (reason: 'pool_timeout' | 'contention' = 'pool_timeout') =>
  new AppError(503, 'database_busy', 'The checkout is busy, please try again', { reason });

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'bad_request', message, details);
