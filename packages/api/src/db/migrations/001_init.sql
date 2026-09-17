-- Snack bar self-checkout: full schema.
--
-- Nothing is deployed yet, so this file is the whole schema rather than a
-- history of changes: one place to read to know what a table looks like. Once
-- the system runs anywhere real, changes become additive migrations, and the
-- online expand/contract procedure in DISTRIBUTED_ARCHITECTURE.md applies.
--
-- Two ideas shape everything here:
--
-- 1. ADR-005: money is always an integer count of the currency's minor unit
--    (cents/centavos), never NUMERIC or float, and every column carrying one is
--    suffixed _cents. The currency itself lives on the store.
--
-- 2. The store is the partition key. Every table a store owns has store_id as
--    the FIRST column of its primary key, and foreign keys between those tables
--    carry it too. No transaction ever spans two stores. That is what allows
--    stores to be split across database shards later without distributed
--    transactions — and it is the one property that is painful to retrofit,
--    because a distributed Postgres needs the distribution column inside every
--    primary key and unique constraint.

-- ---------------------------------------------------------------------------
-- Global tables: shared by every store
-- ---------------------------------------------------------------------------

-- A physical location. Currency, tax and locale are per store, not global
-- configuration: two stores may be in different countries.
CREATE TABLE stores (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code             VARCHAR(32)  NOT NULL UNIQUE,  -- human reference, e.g. 'BR-SP-0001'
    name             VARCHAR(255) NOT NULL,
    country_code     CHAR(2)      NOT NULL,         -- ISO 3166-1 alpha-2
    region           VARCHAR(64)  NOT NULL,         -- grouping hint for future shard placement
    timezone         VARCHAR(64)  NOT NULL,         -- IANA, e.g. 'America/Sao_Paulo'
    currency         CHAR(3)      NOT NULL,         -- ISO 4217; all *_cents here are in this currency
    locale           VARCHAR(16)  NOT NULL,         -- BCP 47, e.g. 'pt-BR'
    -- No default on purpose: stores get opened by copying the last INSERT, and a
    -- silent 0 produces months of orders with tax_cents = 0 that surface at
    -- quarter close. Zero is a legitimate choice (tax-inclusive pricing) but it
    -- has to be chosen.
    tax_basis_points INT          NOT NULL CHECK (tax_basis_points >= 0),
    active           BOOLEAN      NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The catalog: what a product IS. No price — a single price cannot express two
-- currencies, so prices live per store in store_items.
CREATE TABLE items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    image_url   VARCHAR(500),
    active      BOOLEAN NOT NULL DEFAULT true,      -- discontinued everywhere
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Store-owned tables
-- ---------------------------------------------------------------------------

-- The five or so screens in a store. Orders record which one made them, and
-- this is where per-device identity will hang once totems authenticate.
CREATE TABLE totems (
    store_id   UUID        NOT NULL REFERENCES stores(id),
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    label      VARCHAR(64) NOT NULL,                -- e.g. 'T1', printed on the device
    active     BOOLEAN     NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store_id, id),
    UNIQUE (store_id, label)
);

-- A store's product range and its price, in the store's currency.
CREATE TABLE store_items (
    store_id    UUID        NOT NULL REFERENCES stores(id),
    item_id     UUID        NOT NULL REFERENCES items(id),
    price_cents BIGINT      NOT NULL CHECK (price_cents >= 0),
    active      BOOLEAN     NOT NULL DEFAULT true,  -- withdrawn from this store only
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store_id, item_id)
);

-- Physical stock on one store's shelf.
--
-- ADR-004: available = quantity - reserved. `reserved` is held for orders in
-- progress; `quantity` only ever drops when a payment succeeds. The CHECK
-- constraints are the last line of defence against overselling and must not be
-- dropped. Stock can only exist for a product the store actually sells.
CREATE TABLE stock (
    store_id   UUID NOT NULL,
    item_id    UUID NOT NULL,
    quantity   INT  NOT NULL DEFAULT 0,             -- physical units on hand
    reserved   INT  NOT NULL DEFAULT 0,             -- held for in-progress orders
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store_id, item_id),
    FOREIGN KEY (store_id, item_id) REFERENCES store_items (store_id, item_id),
    CHECK (quantity >= 0),
    CHECK (reserved >= 0),
    CHECK (quantity >= reserved)
);

-- An anonymous checkout session (ADR-002: no users, no accounts).
--
-- status: pending | confirmed | paid | failed | cancelled | expired
--   'confirmed' means a payment is in flight. The order leaves 'pending' before
--   the terminal is called, so a double-tap on Pay cannot charge twice, and the
--   expiry job deliberately skips 'confirmed' — releasing that stock could
--   oversell an item the customer was in fact charged for.
--
-- Note: id alone is not unique here, only (store_id, id). Ids are random UUIDs,
-- and every lookup carries the store.
CREATE TABLE orders (
    store_id       UUID         NOT NULL REFERENCES stores(id),
    id             UUID         NOT NULL DEFAULT gen_random_uuid(),
    totem_id       UUID         NOT NULL,
    session_id     VARCHAR(255) NOT NULL,           -- anonymous totem session
    status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
    -- Snapshotted like the prices are: if a store ever changes currency, an old
    -- order must still read in the currency it was actually charged in.
    currency       CHAR(3)      NOT NULL,
    subtotal_cents BIGINT       NOT NULL DEFAULT 0,
    tax_cents      BIGINT       NOT NULL DEFAULT 0,
    total_cents    BIGINT       NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ  NOT NULL,           -- session TTL
    PRIMARY KEY (store_id, id),
    -- An order can only come from a totem registered to the same store.
    FOREIGN KEY (store_id, totem_id) REFERENCES totems (store_id, id)
);

-- Line items. unit_price_cents is a snapshot: a later price change must not
-- rewrite what a customer was charged. item_id points at the global catalog
-- rather than store_items, so history survives a store dropping a product.
CREATE TABLE order_items (
    store_id         UUID   NOT NULL,
    id               UUID   NOT NULL DEFAULT gen_random_uuid(),
    order_id         UUID   NOT NULL,
    item_id          UUID   NOT NULL REFERENCES items(id),
    quantity         INT    NOT NULL CHECK (quantity > 0),
    unit_price_cents BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    FOREIGN KEY (store_id, order_id) REFERENCES orders (store_id, id)
);

-- One row per payment attempt (ADR-003).
--
-- status: pending | succeeded | failed | unknown
--   'unknown' is a real outcome, not an error: the processor timed out and we
--   must never assume either way.
--
-- The idempotency key embeds the order UUID, so it stays globally unique even
-- though the constraint is per store — a distributed table cannot enforce
-- uniqueness that omits the distribution column.
CREATE TABLE payments (
    store_id            UUID         NOT NULL,
    id                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    order_id            UUID         NOT NULL,
    amount_cents        BIGINT       NOT NULL,
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
    method              VARCHAR(20),                -- card | wallet | qr
    provider_payment_id VARCHAR(255),               -- Stripe/SumUp reference
    idempotency_key     VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    -- How many times the resolver has asked the gateway about this attempt, and
    -- when it last asked. A payment that is still unresolved after the budget
    -- stops being retried and waits for a human instead of asking forever.
    resolve_attempts    INT          NOT NULL DEFAULT 0,
    last_attempt_at     TIMESTAMPTZ,
    PRIMARY KEY (store_id, id),
    UNIQUE (store_id, idempotency_key),
    FOREIGN KEY (store_id, order_id) REFERENCES orders (store_id, id)
);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Store-owned indexes lead with store_id. Sizes and plans were measured against
-- 200k orders / 600k lines and again with 2,001 stores; see
-- PROGRESS.md "Index tuning".
-- ---------------------------------------------------------------------------

CREATE INDEX idx_items_active ON items (active) WHERE active = true;

CREATE INDEX idx_totems_store ON totems (store_id) WHERE active;

CREATE INDEX idx_orders_store_session ON orders (store_id, session_id);

-- Serves both the live-order lookups and the per-store reconciliation probe.
-- Partial keeps it to the handful of live orders rather than indexing a column
-- that is mostly 'paid'. The trailing updated_at supplies the ORDER BY.
CREATE INDEX idx_orders_store_live ON orders (store_id, status, updated_at)
    WHERE status IN ('pending', 'confirmed');

-- Deliberate exception to "store first": the expiry reaper sweeps every store
-- in one pass. After sharding, the same sweep runs once per shard.
CREATE INDEX idx_orders_expiry ON orders (expires_at) WHERE status = 'pending';

CREATE INDEX idx_order_items_store_order ON order_items (store_id, order_id);

CREATE INDEX idx_payments_store_order ON payments (store_id, order_id, created_at);

-- The resolver's scan: payment attempts that never reached a terminal state.
-- Another deliberate exception to "store first" — like the expiry reaper, it
-- sweeps every store in one pass, and runs once per shard after sharding.
CREATE INDEX idx_payments_unresolved ON payments (created_at)
    WHERE status IN ('pending', 'unknown');

-- Deliberately NOT indexed: order_items(item_id). It is an unindexed foreign
-- key, which normally warrants fixing, but nothing deletes or re-keys an item
-- (the catalog soft-deletes via items.active) and no current query drives from
-- it. Measured at 4.3 MB on 600k lines with a write cost on the hottest insert
-- path, for zero read benefit. Add it when per-item reporting arrives.
