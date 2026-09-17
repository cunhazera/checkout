## Store-owned products

**Status: implemented 2026-09-17.**

Before this change the catalog was global: one `items` row per product shared by every store, with
price and range in `store_items`. That allows a national mistake (disabling a catalog
item empties every menu in the country) and it doesn't match how the business actually
works — a totem is filled from a local shelf, with no central warehouse. This spec makes
every product belong to exactly one store, and removes the menu cache so availability is
never stale.

### Requirements

**Functional**
- A product belongs to one store. Creating, pricing, renaming, disabling or stocking it
  affects that store only. No action in one store can change what another sells.
- Disabling is per store and is the **only** off switch. There is no global or regional
  deactivation.
- Stock stays per store: a store's totems sell from one shared shelf, and reservation
  keeps its row lock, so two totems can never take the same last unit.
- A store's menu reflects current stock on **every** request. No stale availability.
- Orders keep referring to the product they sold, including after it is disabled.
  Products are never hard-deleted.

**Non-functional**
- Menu read stays around a millisecond per store at fleet scale (measured 0.33 ms with
  2,001 stores and 200k stock rows, on the store-first keys).
- No cross-store transaction or join is introduced. The store remains the partition key,
  so sharding by store stays available.

**Constraints and assumptions**
- Reporting is per store. Nothing compares products across stores, so no shared product
  identity is required.
- Payments stay mocked; this is a demonstration system.
- A store that cannot reach the API goes out of service rather than selling offline.

### Technical decisions

- **One `products` table, keyed `(store_id, id)`**, holding name, description, image,
  `price_cents` and `active`. This merges `items` and `store_items`: once definitions are
  not shared, a separate catalog table holds nothing but a foreign key. Fewer joins, one
  place to look, and the store-first key keeps sharding open.
- **`stock` keys off `(store_id, product_id)`** — same behaviour as now, same locks, same
  `CHECK (quantity >= reserved)`.
- **`order_items` references `(store_id, product_id)`**, with products soft-deleted via
  `active` so history survives a withdrawal. The unit price stays snapshotted on the line.
- **The menu cache is removed** (`MENU_CACHE_MS`, `invalidateMenuCache`). The in-process
  cache is cleared only on the instance that took the sale, so a second API instance
  reintroduces stale "available" — which the customer meets *after* committing to pay.
  Reading from the database is cheap enough that the cache buys nothing worth that.
- **The store settings cache stays** (30 s: currency, tax, locale). It never affects stock,
  and those values change rarely.
- **The global-deactivation failure mode disappears structurally.** The mitigation recorded
  in `DISTRIBUTED_ARCHITECTURE.md` — "catalog deactivation is refused while any store still
  lists the item" — becomes unnecessary: there is no global switch left to misuse. A rule
  nobody can break beats a rule somebody must remember.

### Open questions

- **The payment port's shape.** `charge()` blocking plus `getStatus()` polling suits wallet
  and QR payments, but not a card-present reader: collection routinely exceeds the 15 s
  call timeout, which would push normal payments down the reconciliation path — the
  emergency route used as the happy path. If a real reader is ever added, split it into
  `startPayment()` returning a reference and a poll for the result. Mocked today, so not
  blocking.
- **Per-totem stock** was considered and rejected. If totems later become individually
  stocked machines, `products` and `stock` gain a `totem_id` and the reservation lock moves
  down one level; nothing else in the design changes.

### Out of scope

- **Restocking.** `stock.quantity` is updated by hand. Drift between the database and the
  physical shelf is accepted for now, and is not a priority for this system.
- **Store and product onboarding.** A new store's products are inserted manually — no
  admin surface, no import, no copying from a template store.
- **Offline selling.** A totem that cannot reach the API shows out of service.
- **Real payment processing**, refunds, and fiscal receipts.
- **Cross-store reporting**, promotions, and shared price lists.
