import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MenuItem, Order, PaymentMethod, Store } from '../api/types';
import { configureMoney, estimateTax } from '../money';
import { configureLanguage, t } from '../i18n';

export type Screen = 'welcome' | 'shop' | 'review' | 'pay' | 'done';
export type Result = 'approved' | 'declined' | 'unknown' | null;

export interface CartLine {
  item: MenuItem;
  quantity: number;
}

/** Inactivity thresholds. Shorter on pay — stock is reserved by then. */
const IDLE_PROMPT_MS = 120_000;
const IDLE_GRACE_MS = 30_000;
const SUCCESS_RESET_MS = 12_000;
const MENU_POLL_MS = 10_000;

export function useSession() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [store, setStore] = useState<Store | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [menuError, setMenuError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('');

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingQty, setPendingQty] = useState(1);

  const [order, setOrder] = useState<Order | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [supportReference, setSupportReference] = useState<string | null>(null);

  const [idlePrompt, setIdlePrompt] = useState(false);

  // --- catalog -------------------------------------------------------------

  const refreshMenu = useCallback(async () => {
    try {
      setMenu(await api.getMenu());
      setMenuError(null);
    } catch (err) {
      setMenuError(err instanceof ApiError ? err.message : t('menuUnavailable'));
    }
  }, []);

  useEffect(() => {
    api
      .getStore()
      .then((st) => {
        setStore(st);
        configureMoney({ currency: st.currency, locale: st.locale });
        // Words and money come from the same place: the store's locale.
        configureLanguage(st.locale);
      })
      .catch(() => {
        /* fall back to the built-in USD default */
      });
    void refreshMenu();
  }, [refreshMenu]);

  // Keep availability live while browsing — the design wants sold-out items to
  // go unavailable in real time.
  useEffect(() => {
    if (screen !== 'shop') return;
    const t = setInterval(() => void refreshMenu(), MENU_POLL_MS);
    return () => clearInterval(t);
  }, [screen, refreshMenu]);

  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);

  const lines = useMemo<CartLine[]>(
    () =>
      Object.entries(cart)
        .map(([id, quantity]) => {
          const item = byId.get(id);
          return item ? { item, quantity } : null;
        })
        .filter((l): l is CartLine => l !== null),
    [cart, byId],
  );

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotalCents = lines.reduce((n, l) => n + l.item.priceCents * l.quantity, 0);
  const taxCents = estimateTax(subtotalCents, store?.taxBasisPoints ?? 0);
  const totalCents = subtotalCents + taxCents;

  /** Server totals once an order exists; the client estimate only before that. */
  const totals = order
    ? { subtotalCents: order.subtotalCents, taxCents: order.taxCents, totalCents: order.totalCents }
    : { subtotalCents, taxCents, totalCents };

  // --- session lifecycle ---------------------------------------------------

  const reset = useCallback(() => {
    setCart({});
    setOrder(null);
    setMethod(null);
    setResult(null);
    setFailureMessage(null);
    setSupportReference(null);
    setPendingId(null);
    setPendingQty(1);
    setStatus('');
    setSessionId(null);
    setIdlePrompt(false);
    setScreen('welcome');
    void refreshMenu();
  }, [refreshMenu]);

  const endSession = useCallback(async () => {
    // Release any reservation this session is still holding.
    if (order && order.status === 'pending') {
      await api.cancel(order.id).catch(() => {
        /* expiry job will reap it; never block the reset on this */
      });
    }
    reset();
  }, [order, reset]);

  const start = useCallback(async () => {
    try {
      const session = await api.startSession();
      setSessionId(session.sessionId);
      setScreen('shop');
      void refreshMenu();
    } catch {
      setMenuError(t('cannotStart'));
    }
  }, [refreshMenu]);

  // --- cart ----------------------------------------------------------------

  const openConfirm = useCallback((itemId: string) => {
    setPendingId(itemId);
    setPendingQty(1);
  }, []);

  const closeConfirm = useCallback(() => {
    setPendingId(null);
    setPendingQty(1);
  }, []);

  const confirmAdd = useCallback(() => {
    if (!pendingId) return;
    const item = byId.get(pendingId);
    if (!item) return;
    setCart((c) => ({ ...c, [pendingId]: (c[pendingId] ?? 0) + pendingQty }));
    setStatus(t('itemAdded', { name: item.name }));
    closeConfirm();
  }, [pendingId, pendingQty, byId, closeConfirm]);

  const setQuantity = useCallback((itemId: string, quantity: number) => {
    setCart((c) => {
      const next = { ...c };
      if (quantity <= 0) delete next[itemId];
      else next[itemId] = quantity;
      return next;
    });
  }, []);

  const emptyCart = useCallback(() => {
    setCart({});
    setStatus(t('basketEmptied'));
  }, []);

  // --- order + payment -----------------------------------------------------

  /**
   * Creates the order — and therefore reserves stock — at the moment the
   * customer commits to paying, not earlier. Holding a reservation through
   * browsing would block other customers for no reason.
   *
   * A 409 means something sold out while the cart sat there. The offending line
   * is dropped and the customer returns to the basket, per the design's
   * "just sold out and was removed from your order".
   */
  const goToPay = useCallback(async () => {
    if (!sessionId || lines.length === 0) return;
    setBusy(true);
    setFailureMessage(null);
    try {
      const created = await api.createOrder(
        sessionId,
        lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity })),
      );
      setOrder(created);
      setScreen('pay');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'item_out_of_stock' && err.itemId) {
        const name = err.itemName ?? 'That item';
        setQuantity(err.itemId, 0);
        setFailureMessage(t('soldOutRemoved', { name }));
        setStatus(t('itemSoldOutStatus', { name }));
        await refreshMenu();
        setScreen('review');
      } else {
        setFailureMessage(err instanceof ApiError ? err.message : t('couldNotStartOrder'));
      }
    } finally {
      setBusy(false);
    }
  }, [sessionId, lines, setQuantity, refreshMenu]);

  const pay = useCallback(async () => {
    if (!order || !method) return;
    setBusy(true);
    setFailureMessage(null);
    try {
      // ADR-003: resolves synchronously, including up to 30s of reconciliation.
      const res = await api.pay(order.id, method);
      if (res.status === 'succeeded') {
        setResult('approved');
      } else if (res.status === 'failed') {
        setResult('declined');
        setFailureMessage(t('nothingWasCharged'));
        // Stock was released server-side, so the old order is dead. A retry
        // re-reserves from the cart, which is still intact.
        setOrder(null);
      } else {
        // Never claim "nothing was charged" on an unknown outcome.
        setResult('unknown');
        setSupportReference(res.supportReference ?? order.id);
      }
      setScreen('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'order_expired') {
        setResult('declined');
        setFailureMessage(t('sessionTimedOut'));
        setOrder(null);
        setScreen('done');
      } else {
        setFailureMessage(err instanceof ApiError ? err.message : t('couldNotPay'));
      }
    } finally {
      setBusy(false);
    }
  }, [order, method]);

  /** Failure retry: the basket survives, so rebuild the order from it. */
  const retryPayment = useCallback(async () => {
    setResult(null);
    setFailureMessage(null);
    setMethod(null);
    if (order) setScreen('pay');
    else await goToPay();
  }, [order, goToPay]);

  const cancelPay = useCallback(async () => {
    if (order && order.status === 'pending') {
      await api.cancel(order.id).catch(() => {});
      setOrder(null);
      await refreshMenu();
    }
    setMethod(null);
    setScreen('review');
  }, [order, refreshMenu]);

  // --- auto-return after a successful sale ---------------------------------

  useEffect(() => {
    if (screen !== 'done' || result !== 'approved') return;
    const t = setTimeout(() => void endSession(), SUCCESS_RESET_MS);
    return () => clearTimeout(t);
  }, [screen, result, endSession]);

  // --- inactivity ----------------------------------------------------------

  const lastTouch = useRef(Date.now());
  const touch = useCallback(() => {
    lastTouch.current = Date.now();
    setIdlePrompt(false);
  }, []);

  useEffect(() => {
    // Welcome is the idle state, and the result screen has its own timer.
    if (screen === 'welcome' || screen === 'done') return;
    const t = setInterval(() => {
      const idleFor = Date.now() - lastTouch.current;
      if (idleFor > IDLE_PROMPT_MS + IDLE_GRACE_MS) void endSession();
      else if (idleFor > IDLE_PROMPT_MS) setIdlePrompt(true);
    }, 1_000);
    return () => clearInterval(t);
  }, [screen, endSession]);

  // A payment in flight must never be interrupted by the idle reaper.
  useEffect(() => {
    if (busy) touch();
  }, [busy, touch]);

  return {
    screen,
    store,
    menu,
    menuError,
    lines,
    cart,
    itemCount,
    totals,
    status,
    pending: pendingId ? (byId.get(pendingId) ?? null) : null,
    pendingQty,
    order,
    method,
    busy,
    result,
    failureMessage,
    supportReference,
    idlePrompt,
    actions: {
      start,
      touch,
      openConfirm,
      closeConfirm,
      setPendingQty,
      confirmAdd,
      setQuantity,
      emptyCart,
      goToShop: () => setScreen('shop'),
      goToReview: () => setScreen('review'),
      goToPay,
      setMethod,
      pay,
      retryPayment,
      cancelPay,
      endSession,
      dismissFailure: () => setFailureMessage(null),
    },
  };
}
