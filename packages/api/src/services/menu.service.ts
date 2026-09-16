import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { cents, type Cents } from '../money.js';

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  priceCents: Cents;
  imageUrl: string | null;
  availableQuantity: number;
  outOfStock: boolean;
}

interface CacheEntry {
  items: MenuItem[];
  at: number;
}

/**
 * One entry per store. ADR-001 rejected Redis and that still holds for a single
 * API instance: a store's menu fits in memory. The cache is keyed by store id
 * so that moving it to a shared cache later is a change of storage, not of
 * design — see DISTRIBUTED_ARCHITECTURE.md.
 *
 * Stock writes invalidate only their own store's entry. A 10-second stale
 * window after a sellout is precisely the "item sells out while in cart" bug,
 * so the TTL is a ceiling on staleness, not the only refresh path.
 *
 * This cache decides what the screen shows, never whether a sale is allowed:
 * reserveStock always locks the real stock row.
 */
const cache = new Map<string, CacheEntry>();

export function invalidateMenuCache(storeId?: string): void {
  if (storeId) cache.delete(storeId);
  else cache.clear();
}

export async function getMenu(storeId: string): Promise<MenuItem[]> {
  const hit = cache.get(storeId);
  if (hit && Date.now() - hit.at < config.menuCacheMs) return hit.items;

  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    price_cents: number;
    image_url: string | null;
    available: number;
  }>(
    `SELECT i.id, i.name, i.description, si.price_cents, i.image_url,
            (s.quantity - s.reserved) AS available
       FROM store_items si
       JOIN items i ON i.id = si.item_id
       JOIN stock s ON s.store_id = si.store_id AND s.item_id = si.item_id
      WHERE si.store_id = $1
        AND si.active
        AND i.active
      ORDER BY i.name`,
    [storeId],
  );

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: cents(r.price_cents),
    imageUrl: r.image_url,
    availableQuantity: r.available,
    outOfStock: r.available <= 0,
  }));

  cache.set(storeId, { items, at: Date.now() });
  return items;
}
