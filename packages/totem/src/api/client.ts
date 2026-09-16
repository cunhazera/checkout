import type { Menu, Order, PayResult, PaymentMethod, Session, Store } from './types';

/**
 * Which store and totem this device is. Provisioned per device at install time
 * through build-time env vars for now; the defaults are the seeded LOCAL-0001
 * store and its totem T1.
 *
 * Later this identity comes from the device's own credential (a per-totem
 * certificate), and the server derives the store from it instead of trusting
 * the URL. The URLs stay the same.
 */
export const STORE_ID: string = import.meta.env.VITE_STORE_ID ?? 'a0000000-0000-4000-8000-000000000001';
export const TOTEM_ID: string = import.meta.env.VITE_TOTEM_ID ?? 'b0000000-0000-4000-8000-000000000001';

const BASE = `/api/v1/stores/${STORE_ID}`;

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

  get itemName(): string | undefined {
    return typeof this.details.itemName === 'string' ? this.details.itemName : undefined;
  }
  get itemId(): string | undefined {
    return typeof this.details.itemId === 'string' ? this.details.itemId : undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
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

  startSession: () => request<Session>('/sessions', { method: 'POST' }),

  createOrder: (sessionId: string, items: { itemId: string; quantity: number }[]) =>
    request<Order>('/orders', {
      method: 'POST',
      body: JSON.stringify({ sessionId, totemId: TOTEM_ID, items }),
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
