import { pool } from '../db/pool.js';
import { cents, type Cents } from '../money.js';

export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  priceCents: Cents;
  imageUrl: string | null;
  availableQuantity: number;
  outOfStock: boolean;
}

/**
 * One store's menu, read fresh every time.
 *
 * There is deliberately no cache here. An in-process one is cleared only on the
 * instance that took the sale, so the moment a second API instance exists a
 * sold-out product keeps showing as available on the others — and the customer
 * meets that at the pay screen, after choosing to pay. Reading costs about a
 * millisecond per store (measured with 2,001 stores and 200k stock rows), which
 * is not worth trading for that.
 *
 * Availability shown here is never what authorises a sale: reserveStock locks
 * the real row inside the transaction.
 */
export async function getMenu(storeId: string): Promise<MenuProduct[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    price_cents: number;
    image_url: string | null;
    available: number;
  }>(
    `SELECT p.id, p.name, p.description, p.price_cents, p.image_url,
            (s.quantity - s.reserved) AS available
       FROM products p
       JOIN stock s ON s.store_id = p.store_id AND s.product_id = p.id
      WHERE p.store_id = $1
        AND p.active
      ORDER BY p.name`,
    [storeId],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: cents(r.price_cents),
    imageUrl: r.image_url,
    availableQuantity: r.available,
    outOfStock: r.available <= 0,
  }));
}
