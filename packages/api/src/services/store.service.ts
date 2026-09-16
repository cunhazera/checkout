import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { storeNotFound } from '../errors.js';

/**
 * A physical location. Everything a customer is charged is expressed in this
 * store's currency and taxed at this store's rate — none of that is global
 * configuration any more.
 */
export interface Store {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  region: string;
  timezone: string;
  currency: string;
  locale: string;
  taxBasisPoints: number;
}

interface CacheEntry {
  store: Store;
  at: number;
}

/**
 * In-process, keyed by store. Correct for one API instance. Once several
 * instances run behind a load balancer this becomes a shared cache under the
 * same key (see DISTRIBUTED_ARCHITECTURE.md), which is why the key is the
 * store id and not anything instance-local.
 */
const cache = new Map<string, CacheEntry>();

export function invalidateStoreCache(storeId?: string): void {
  if (storeId) cache.delete(storeId);
  else cache.clear();
}

/** Loads an active store, or throws store_not_found. */
export async function getStore(storeId: string): Promise<Store> {
  const hit = cache.get(storeId);
  if (hit && Date.now() - hit.at < config.storeCacheMs) return hit.store;

  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    country_code: string;
    region: string;
    timezone: string;
    currency: string;
    locale: string;
    tax_basis_points: number;
  }>(
    `SELECT id, code, name, country_code, region, timezone, currency, locale, tax_basis_points
       FROM stores
      WHERE id = $1 AND active`,
    [storeId],
  );

  const row = rows[0];
  if (!row) {
    cache.delete(storeId);
    throw storeNotFound(storeId);
  }

  const store: Store = {
    id: row.id,
    code: row.code,
    name: row.name,
    countryCode: row.country_code,
    region: row.region,
    timezone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    taxBasisPoints: row.tax_basis_points,
  };
  cache.set(storeId, { store, at: Date.now() });
  return store;
}
