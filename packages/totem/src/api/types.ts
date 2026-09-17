/** Mirrors the API's wire format. All money is integer cents (ADR-005). */

/** A product, as one store sells it. Product ids belong to that store alone. */
export interface Product {
  id: string;
  name: string;
  /** Pack size, e.g. "150 g bag". */
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
  items: Product[];
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  storeId: string;
  totemId: string;
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
