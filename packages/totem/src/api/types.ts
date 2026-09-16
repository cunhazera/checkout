/** Mirrors the API's wire format. All money is integer cents (ADR-005). */

export interface MenuItem {
  id: string;
  name: string;
  /** The seed puts the pack size here ("150 g bag"). */
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  availableQuantity: number;
  outOfStock: boolean;
}

/** The store this totem belongs to. Currency, locale and tax come from here. */
export interface Store {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  timezone: string;
  currency: string;
  locale: string;
  taxBasisPoints: number;
}

export interface Menu {
  storeId: string;
  currency: string;
  items: MenuItem[];
}

export interface Session {
  sessionId: string;
  storeId: string;
  expiresAt: string;
}

export interface OrderLine {
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  storeId: string;
  totemId: string;
  sessionId: string;
  currency: string;
  status: 'pending' | 'confirmed' | 'paid' | 'failed' | 'cancelled' | 'expired';
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  expiresAt: string;
  createdAt: string;
  items: OrderLine[];
}

export type PaymentMethod = 'card' | 'wallet' | 'qr';

export interface PayResult {
  storeId: string;
  orderId: string;
  paymentId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  orderStatus: string;
  amountCents: number;
  declineReason?: string;
  supportReference?: string;
}
