import { getIdentity } from '../identity';
import type { Menu, Order, PayResult, PaymentMethod, Store } from './types';

/** Every call is scoped to the store this device belongs to. */
const base = () => `/api/v1/stores/${getIdentity().storeId}`;

/**
 * Carries the API's machine-readable `code`. The design's edge-case table wants
 * specific copy per failure, so screens branch on the code — never on prose.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get productName(): string | undefined {
    return typeof this.details.productName === 'string' ? this.details.productName : undefined;
  }
  get productId(): string | undefined {
    return typeof this.details.productId === 'string' ? this.details.productId : undefined;
  }
}

/**
 * Is this "the checkout service is not answering", rather than "it answered and
 * said no"?
 *
 * Two shapes mean the same thing to a customer. `fetch` throwing is the obvious
 * one. The other is a proxy answering on the API's behalf: in development Vite
 * turns a refused connection into a 500, and in production nginx sits in front
 * of the API container and returns 502 or 504 while it is down or restarting.
 * Those never reach `fetch`'s catch, so a totem that only watched for a thrown
 * request stayed on the welcome screen and silently swallowed every tap.
 *
 * The distinguishing mark is that the API was not the one replying, so there is
 * no machine-readable `code` in the body. A real API fault (`internal_error`,
 * `database_busy`) does carry one and must NOT take the totem out of service —
 * those are transient and the customer should be able to retry.
 */
export const isUnreachable = (err: unknown): boolean =>
  err instanceof ApiError &&
  (err.code === 'network_error' || (err.status >= 500 && err.code === 'unknown_error'));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      ...init,
      // Only declare a JSON body when there actually is one. Sending
      // content-type: application/json with an empty body makes Fastify reject
      // the request with FST_ERR_CTP_EMPTY_JSON_BODY — which is what
      // POST /session/start and DELETE /abandon both are.
      headers: {
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // ADR-007: the totem is offline-first, but the API is on localhost. If this
    // fails the backend is down, which is an operational fault, not a network one.
    throw new ApiError(0, 'network_error', 'Cannot reach the checkout service');
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    const { error, message, ...details } = body as Record<string, unknown>;
    throw new ApiError(
      res.status,
      typeof error === 'string' ? error : 'unknown_error',
      typeof message === 'string' ? message : 'Something went wrong',
      details,
    );
  }
  return body as T;
}

export const api = {
  getStore: () => request<Store>(''),

  getMenu: () => request<Menu>('/menu').then((r) => r.items),

  createOrder: (items: { productId: string; quantity: number }[]) =>
    request<Order>('/orders', {
      method: 'POST',
      body: JSON.stringify({ totemId: getIdentity().totemId, items }),
    }),

  getOrder: (orderId: string) => request<Order>(`/orders/${orderId}`),

  pay: (orderId: string, method: PaymentMethod) =>
    request<PayResult>(`/orders/${orderId}/payments`, {
      method: 'POST',
      body: JSON.stringify({ method }),
    }),

  cancel: (orderId: string) =>
    request<{ status: string }>(`/orders/${orderId}/cancel`, { method: 'POST' }),
};
