import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../api/client';
import type { Order, PayResult, Product, Store } from '../api/types';

/**
 * The API is mocked here on purpose: what these tests are about is how the
 * screen reacts to each answer the server can give — especially the ones a
 * customer only sees on a bad day. The real API is covered by its own suite.
 */
// vi.hoisted, because vi.mock is lifted above ordinary declarations.
const api = vi.hoisted(() => ({
  getStore: vi.fn(),
  getMenu: vi.fn(),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  pay: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api };
});

const { useSession } = await import('./session');

const STORE: Store = {
  id: 'store-1',
  code: 'LOCAL-0001',
  name: 'Snack Bar',
  countryCode: 'US',
  timezone: 'UTC',
  currency: 'USD',
  locale: 'en-US',
  taxBasisPoints: 0,
};

const product = (id: string, priceCents: number, availableQuantity = 10): Product => ({
  id,
  name: `Product ${id}`,
  description: 'size',
  priceCents,
  imageUrl: null,
  availableQuantity,
  outOfStock: availableQuantity <= 0,
});

const MENU = [product('chips', 240), product('cola', 210), product('water', 150, 1)];

const order = (over: Partial<Order> = {}): Order => ({
  id: 'order-1',
  storeId: STORE.id,
  totemId: 'totem-1',
  status: 'pending',
  currency: 'USD',
  subtotalCents: 480,
  taxCents: 0,
  totalCents: 480,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  items: [],
  ...over,
});

const payResult = (over: Partial<PayResult> = {}): PayResult => ({
  storeId: STORE.id,
  orderId: 'order-1',
  paymentId: 'payment-1',
  status: 'succeeded',
  orderStatus: 'paid',
  amountCents: 480,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getStore.mockResolvedValue(STORE);
  api.getMenu.mockResolvedValue(MENU);
  api.cancel.mockResolvedValue({ status: 'cancelled' });
});

/** Boots the hook and walks it to the shop screen with items in the basket. */
async function withBasket(lines: [string, number][] = [['chips', 2]]) {
  const view = renderHook(() => useSession());
  await waitFor(() => expect(view.result.current.menu).toHaveLength(3));
  await act(async () => view.result.current.actions.start());

  for (const [id, qty] of lines) {
    act(() => view.result.current.actions.openConfirm(id));
    act(() => view.result.current.actions.setPendingQty(qty));
    act(() => view.result.current.actions.confirmAdd());
  }
  return view;
}

describe('when the totem cannot reach the API', () => {
  it('goes out of service rather than leaving the customer tapping', async () => {
    // The bug this guards: the error used to be written to state that only the
    // product grid rendered, and the grid is never reached from the welcome
    // screen. Tapping a dead totem did nothing at all.
    api.getStore.mockRejectedValue(new ApiError(0, 'network_error', 'Cannot reach the checkout service'));
    api.getMenu.mockRejectedValue(new ApiError(0, 'network_error', 'Cannot reach the checkout service'));

    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.serviceDown).toBe(true));
  });

  it('comes back on its own when the API returns', async () => {
    // Fake timers from the start: the retry interval is created the moment the
    // totem goes down, so it has to be a fake one to be advanced later.
    vi.useFakeTimers();
    try {
      api.getStore.mockRejectedValue(new ApiError(0, 'network_error', 'offline'));
      api.getMenu.mockRejectedValue(new ApiError(0, 'network_error', 'offline'));

      const { result } = renderHook(() => useSession());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // let the mount's requests settle
      });
      expect(result.current.serviceDown).toBe(true);

      api.getStore.mockResolvedValue(STORE);
      api.getMenu.mockResolvedValue(MENU);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      // A totem that fixes itself beats one that needs a member of staff.
      expect(result.current.serviceDown).toBe(false);
      expect(result.current.menu).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not go out of service for an ordinary error', async () => {
    // A 500 from a reachable API is a different problem: the totem stays up.
    api.getMenu.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.menuError).toBe('boom'));
    expect(result.current.serviceDown).toBe(false);
  });

  it('goes out of service when a proxy answers for a dead API', async () => {
    // The bug this guards, found by pointing the totem at a dead API: the
    // request never throws, because Vite (dev) and nginx (production) answer on
    // the API's behalf with a 5xx and no JSON body. The totem stayed on the
    // welcome screen and ate every tap, showing the customer nothing at all.
    const proxied = new ApiError(502, 'unknown_error', 'Something went wrong');
    api.getStore.mockRejectedValue(proxied);
    api.getMenu.mockRejectedValue(proxied);

    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.serviceDown).toBe(true));
  });

  it('stays up when the API itself is merely busy', async () => {
    // 503 database_busy is a real answer from a reachable API: transient, and
    // the customer should be able to try again rather than meet a dead screen.
    api.getMenu.mockRejectedValue(
      new ApiError(503, 'database_busy', 'The checkout is busy, please try again'),
    );
    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.menuError).toBeTruthy());
    expect(result.current.serviceDown).toBe(false);
  });
});

describe('the basket', () => {
  it('adds an item and totals it', async () => {
    const { result } = await withBasket();

    expect(result.current.itemCount).toBe(2);
    expect(result.current.totals.subtotalCents).toBe(480);
    expect(result.current.totals.totalCents).toBe(480);
    expect(result.current.status).toBe('Product chips added');
  });

  it('totals several lines', async () => {
    const { result } = await withBasket([
      ['chips', 2],
      ['cola', 3],
    ]);

    expect(result.current.itemCount).toBe(5);
    expect(result.current.totals.subtotalCents).toBe(480 + 630);
  });

  it('applies the store tax rate to the estimate shown before ordering', async () => {
    api.getStore.mockResolvedValue({ ...STORE, taxBasisPoints: 800 });
    const { result } = await withBasket();

    expect(result.current.totals.subtotalCents).toBe(480);
    expect(result.current.totals.taxCents).toBe(38); // 8% of 480, rounded once
    expect(result.current.totals.totalCents).toBe(518);
  });

  it('removes a line when its quantity reaches zero', async () => {
    const { result } = await withBasket();
    act(() => result.current.actions.setQuantity('chips', 0));

    expect(result.current.itemCount).toBe(0);
    expect(result.current.lines).toHaveLength(0);
  });

  it('empties the basket without ending the session', async () => {
    const { result } = await withBasket();
    act(() => result.current.actions.emptyCart());

    expect(result.current.itemCount).toBe(0);
    expect(result.current.screen).toBe('shop');
    expect(result.current.status).toBe('Basket emptied.');
  });
});

describe('when an item sells out while the basket sits there', () => {
  it('drops the line, explains why, and returns to the basket', async () => {
    const { result } = await withBasket([
      ['chips', 2],
      ['water', 1],
    ]);
    act(() => result.current.actions.goToReview());

    const menuReadsBefore = api.getMenu.mock.calls.length;
    api.createOrder.mockRejectedValue(
      new ApiError(409, 'product_out_of_stock', 'Still water is no longer available', {
        productId: 'water',
        productName: 'Still water',
      }),
    );

    await act(async () => result.current.actions.goToPay());

    // The customer keeps everything that is still available.
    expect(result.current.screen).toBe('review');
    expect(result.current.lines.map((l) => l.product.id)).toEqual(['chips']);
    expect(result.current.failureMessage).toBe(
      'Still water just sold out and was removed from your order.',
    );
    // And the menu is re-read, so the sold-out tile updates too.
    expect(api.getMenu.mock.calls.length).toBe(menuReadsBefore + 1);
  });
});

describe('paying', () => {
  it('moves to the result screen when the payment succeeds', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());
    api.pay.mockResolvedValue(payResult());

    await act(async () => result.current.actions.goToPay());
    expect(result.current.screen).toBe('pay');
    // The server's total replaces the client's estimate.
    expect(result.current.totals.totalCents).toBe(480);

    act(() => result.current.actions.setMethod('card'));
    await act(async () => result.current.actions.pay());

    expect(result.current.screen).toBe('done');
    expect(result.current.result).toBe('approved');
  });

  it('keeps the basket after a decline so the customer can retry', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());
    api.pay.mockResolvedValue(
      payResult({ status: 'failed', orderStatus: 'failed', declineReason: 'insufficient_funds' }),
    );

    await act(async () => result.current.actions.goToPay());
    act(() => result.current.actions.setMethod('card'));
    await act(async () => result.current.actions.pay());

    expect(result.current.result).toBe('declined');
    expect(result.current.itemCount).toBe(2); // basket survives
    expect(result.current.order).toBeNull(); // the dead order is discarded

    // Retrying builds a fresh order from the basket that is still there.
    api.createOrder.mockResolvedValue(order({ id: 'order-2' }));
    await act(async () => result.current.actions.retryPayment());
    expect(result.current.screen).toBe('pay');
  });

  it('never claims an unknown payment failed', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());
    api.pay.mockResolvedValue(
      payResult({ status: 'unknown', orderStatus: 'confirmed', supportReference: 'order-1' }),
    );

    await act(async () => result.current.actions.goToPay());
    act(() => result.current.actions.setMethod('card'));
    await act(async () => result.current.actions.pay());

    expect(result.current.result).toBe('unknown');
    expect(result.current.supportReference).toBe('order-1');
  });

  it('explains an expired session instead of showing a raw error', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());
    api.pay.mockRejectedValue(new ApiError(410, 'order_expired', 'This order has expired'));

    await act(async () => result.current.actions.goToPay());
    act(() => result.current.actions.setMethod('card'));
    await act(async () => result.current.actions.pay());

    expect(result.current.screen).toBe('done');
    expect(result.current.failureMessage).toMatch(/timed out/i);
  });

  it('releases the reservation when the customer cancels at the pay screen', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());

    await act(async () => result.current.actions.goToPay());
    await act(async () => result.current.actions.cancelPay());

    expect(api.cancel).toHaveBeenCalledWith('order-1');
    expect(result.current.screen).toBe('review');
    expect(result.current.itemCount).toBe(2); // the basket is not lost
  });
});

describe('ending the session', () => {
  it('cancels an unpaid order and resets to the welcome screen', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());

    await act(async () => result.current.actions.goToPay());
    await act(async () => result.current.actions.endSession());

    expect(api.cancel).toHaveBeenCalledWith('order-1');
    expect(result.current.screen).toBe('welcome');
    expect(result.current.itemCount).toBe(0);
    expect(result.current.result).toBeNull();
  });

  it('still resets if releasing the order fails', async () => {
    const { result } = await withBasket();
    api.createOrder.mockResolvedValue(order());
    api.cancel.mockRejectedValue(new ApiError(0, 'network_error', 'offline'));

    await act(async () => result.current.actions.goToPay());
    await act(async () => result.current.actions.endSession());

    // The next customer must not inherit this one's basket, whatever the server says.
    expect(result.current.screen).toBe('welcome');
    expect(result.current.itemCount).toBe(0);
  });
});
