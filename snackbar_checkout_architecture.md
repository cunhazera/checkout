# Snack Bar Self-Checkout System — Architecture Reference

## Context

A local self-service totem installed at a fixed physical location (snack bar). Users browse the menu, build an order, pay via card terminal, and leave. No cashier, no user accounts, no remote cloud dependency for core operations.

---

## Architectural Decisions

### ADR-001: Single-machine architecture, no distributed systems

**Decision:** Run everything on one local machine. No Kafka, no Redis, no microservices, no API gateway.

**Reasoning:** The scale does not justify distributed infrastructure.

```
Concurrent users:  1-3 (one screen)
Orders per hour:   30-50 at peak
Menu items:        20-100
Daily orders:      200-500
```

A single Postgres instance and one backend service handles this trivially. Adding Kafka and Redis would introduce operational complexity with zero throughput benefit.

**Tradeoff accepted:** No horizontal scaling. If this expands to a chain of locations, the architecture must be revisited — at that point, event-driven sync between locations and a central inventory service becomes justified.

---

### ADR-002: No user accounts — anonymous sessions only

**Decision:** No login, no user registration, no identity management. Orders are anonymous, tied to a short-lived session ID generated when the user approaches the totem.

**Reasoning:** A self-service snack bar does not require user identity. Removing it eliminates the entire auth layer (JWT, sessions, user table) and dramatically reduces LGPD/GDPR scope — no personal data is stored.

**Implications:**
- No order history per user
- No loyalty points
- Payment confirmation must be synchronous — no "we'll email you"
- Session expires on inactivity, releasing stock reservations

**Tradeoff accepted:** No personalization or loyalty features. If these are needed later, a lightweight opt-in (scan QR code to link order to account) can be added without redesigning the core system.

---

### ADR-003: Synchronous payment confirmation

**Decision:** Payment result must be resolved before the user leaves the screen. No async confirmation, no email follow-up.

**Reasoning:** The user is standing at a totem. They need a definitive result immediately. There is no channel to reach them after they walk away.

**Payment state machine:**

```
PENDING → CONFIRMED → PAID
       → FAILED
       → UNKNOWN (timeout — requires manual resolution)
```

**Unknown state handling:** If the payment processor returns a network timeout, the system polls for confirmation every 2 seconds for up to 30 seconds. If still unresolved, display an error with the order ID and a support contact number. Never assume success, never assume failure.

---

### ADR-004: Pessimistic locking for stock reservation

**Decision:** Use `SELECT FOR UPDATE` on the stock table when reserving items, not optimistic locking.

**Reasoning:** At a snack bar, stock quantities are small (e.g. last 2 sandwiches). A lost update means overselling a physical item — unacceptable. The conflict probability is high enough and the operation short enough that pessimistic locking is the correct choice.

**Reservation model:** Stock has two fields — `quantity` (physical count) and `reserved` (held for in-progress orders). Available stock = `quantity - reserved`. Reservations are released on payment failure, session expiry, or order cancellation. Physical decrement happens only on confirmed payment.

**Tradeoff accepted:** Slightly lower write throughput. Acceptable given the scale (single screen, 1-3 concurrent users maximum).

---

### ADR-005: Prices stored in cents as BIGINT

**Decision:** All monetary values stored as integers representing centavos (cents). No NUMERIC, no DECIMAL, no FLOAT.

**Reasoning:** Integer arithmetic is exact. Floating point arithmetic introduces rounding errors that are unacceptable in financial calculations.

```
R$ 1,50 stored as 150
R$ 12,99 stored as 1299
```

**Convention:** All monetary fields suffixed with `_cents` (e.g. `price_cents`, `total_cents`, `amount_cents`). Conversion to display format (divide by 100) happens only at the UI rendering layer, never inside business logic or database queries.

**Tradeoff accepted:** Requires consistent discipline across the codebase. A lint rule or custom type wrapper enforces this at compile time.

---

### ADR-006: Local Postgres, not SQLite

**Decision:** Use a local Postgres instance rather than SQLite.

**Reasoning:** Postgres supports `SELECT FOR UPDATE` (required for stock reservation), proper transaction isolation, and concurrent connections. SQLite's write locking model would serialize all writes — acceptable for reads but problematic if the admin dashboard and totem run simultaneously.

**Tradeoff accepted:** Slightly heavier local setup than SQLite. Acceptable given that Postgres is already a known dependency in the stack.

---

### ADR-007: Offline-first for core operations

**Decision:** All core operations (browse menu, build order, reserve stock, complete payment) must work without internet connectivity.

**Reasoning:** The totem is in a physical location. Internet connectivity is not guaranteed. The card terminal has its own offline mode. Menu and stock data live in local Postgres.

**Optional sync:** If a central reporting system exists, orders sync to it asynchronously when connectivity is available. Core operations are never blocked waiting for this sync.

---

## Data Model

### Entity Relationships

```
Order ──< OrderItem >── Item
                           └── Stock
Order ──── Payment
```

No `Client` / `User` entity. Orders are anonymous.

---

### Schema

```sql
-- Menu items available for purchase
CREATE TABLE items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    price_cents BIGINT NOT NULL,        -- R$ 1,50 stored as 150
    image_url   VARCHAR(500),
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Physical stock count per item
CREATE TABLE stock (
    item_id     UUID PRIMARY KEY REFERENCES items(id),
    quantity    INT NOT NULL DEFAULT 0, -- physical units on hand
    reserved    INT NOT NULL DEFAULT 0, -- held for in-progress orders
    -- available = quantity - reserved
    CHECK (quantity >= 0),
    CHECK (reserved >= 0),
    CHECK (quantity >= reserved),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An anonymous checkout session
CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      VARCHAR(255) NOT NULL,    -- anonymous totem session
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | confirmed | paid | failed | cancelled | expired
    total_cents     BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL      -- session TTL
);

-- Line items within an order
CREATE TABLE order_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID NOT NULL REFERENCES orders(id),
    item_id           UUID NOT NULL REFERENCES items(id),
    quantity          INT NOT NULL CHECK (quantity > 0),
    unit_price_cents  BIGINT NOT NULL -- price snapshot at time of order
);

-- Payment attempt for an order
CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id),
    amount_cents        BIGINT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | succeeded | failed | unknown
    provider_payment_id VARCHAR(255),          -- Stripe/SumUp reference
    idempotency_key     VARCHAR(255) UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_orders_session ON orders(session_id);
CREATE INDEX idx_orders_status ON orders(status) WHERE status = 'pending';
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_items_active ON items(active) WHERE active = true;
```

---

## Request Flows

### Browse Menu

```
GET /menu
  → SELECT id, name, description, price_cents, image_url
    FROM items i
    JOIN stock s ON s.item_id = i.id
    WHERE i.active = true
    ORDER BY i.name

  → available_quantity = s.quantity - s.reserved
  → items with available_quantity = 0 flagged as out of stock
  → cache response for 10 seconds (menu rarely changes)
```

### Start Session

```
POST /session/start
  → generate session_id (UUID)
  → return { sessionId, expiresAt: now + 15 minutes }
  → no database write yet — session only materializes when order is created
```

### Create Order (with stock reservation)

```
POST /orders
  { sessionId, items: [{ itemId, quantity }] }

  BEGIN TRANSACTION
    FOR EACH item:
      SELECT quantity, reserved
      FROM stock
      WHERE item_id = ?
      FOR UPDATE                         ← pessimistic lock

      IF (quantity - reserved) < requested_quantity:
        ROLLBACK
        RETURN 409 { error: "item_out_of_stock", itemId }

      UPDATE stock
      SET reserved = reserved + requested_quantity,
          updated_at = NOW()
      WHERE item_id = ?

    INSERT INTO orders (session_id, status, total_cents, expires_at)
    VALUES (?, 'pending', ?, NOW() + INTERVAL '15 minutes')

    INSERT INTO order_items (order_id, item_id, quantity, unit_price_cents)
    VALUES ... (one row per item, price snapshotted from items table)
  COMMIT

  RETURN 201 { orderId, totalCents, expiresAt }
```

### Process Payment

```
POST /orders/{orderId}/pay
  { paymentMethodToken }

  1. Verify order exists and status = 'pending'
  2. Verify order not expired
  3. Generate idempotency_key = "pay_{orderId}_{attemptNumber}"
  4. INSERT INTO payments (order_id, amount_cents, status, idempotency_key)

  5. Call card terminal / payment processor
     → SUCCESS:
       BEGIN TRANSACTION
         UPDATE payments SET status = 'succeeded', resolved_at = NOW()
         UPDATE orders SET status = 'paid', updated_at = NOW()
         FOR EACH order item:
           UPDATE stock SET
             quantity = quantity - order_item.quantity,
             reserved = reserved - order_item.quantity,
             updated_at = NOW()
       COMMIT
       → Print receipt
       → Show success screen
       → Reset totem after 10 seconds

     → FAILURE:
       UPDATE payments SET status = 'failed', resolved_at = NOW()
       UPDATE orders SET status = 'failed', updated_at = NOW()
       FOR EACH order item:
         UPDATE stock SET
           reserved = reserved - order_item.quantity,
           updated_at = NOW()
       → Show failure screen with retry option

     → TIMEOUT (unknown state):
       UPDATE payments SET status = 'unknown'
       → Poll processor every 2 seconds for up to 30 seconds
       → If resolved: handle as SUCCESS or FAILURE above
       → If still unknown: show support contact + orderId reference
```

### Session Expiry (background job)

```
Runs every 60 seconds:

  SELECT id FROM orders
  WHERE status = 'pending'
    AND expires_at < NOW()

  FOR EACH expired order:
    BEGIN TRANSACTION
      FOR EACH order item:
        UPDATE stock SET
          reserved = reserved - order_item.quantity,
          updated_at = NOW()
      UPDATE orders SET status = 'expired', updated_at = NOW()
    COMMIT

  → Totem inactivity detection (client side):
    No touch for 2 minutes → show "Are you still there?" prompt
    No response in 30 seconds → call DELETE /orders/{orderId}/abandon
    → Reset screen to welcome state
```

---

## Edge Cases and UI Feedback Requirements

Since there is no cashier, every error state must be handled by the UI with clear, specific messaging.

| Scenario | System action | UI message |
|---|---|---|
| Item out of stock during browsing | Mark unavailable in real time | "[Item] is no longer available" |
| Item sells out while in cart | Remove from order, notify | "[Item] just sold out and was removed from your order" |
| Stock reservation fails | Return 409, release partial reservations | "Sorry, [item] is no longer available" |
| Card declined | Release reservation, offer retry | "Payment declined. Please try a different card." |
| Card terminal timeout | Poll for resolution | "Confirming your payment..." then resolve |
| Unknown payment state | Show support contact | "Please contact staff with reference [orderId]" |
| Receipt printer fails | Offer QR/alternative | "Unable to print receipt. Scan QR code for digital copy." |
| Session abandoned | Cancel order, release stock | Reset to welcome screen automatically |
| Internet outage | Core ops continue offline | No user impact — all data is local |

---

## Component Architecture

```
┌─────────────────────────────────────────────────┐
│                  Local Machine                   │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │        Touch Screen UI (React)           │    │
│  │   Browse → Build Order → Pay → Receipt  │    │
│  └──────────────┬──────────────────────────┘    │
│                 │ HTTP (localhost)               │
│  ┌──────────────▼──────────────────────────┐    │
│  │     Backend Service (Kotlin/Spring Boot) │    │
│  │                                          │    │
│  │  OrderController                         │    │
│  │  StockService (reservation logic)        │    │
│  │  PaymentService (terminal integration)   │    │
│  │  SessionCleanupJob (expiry scheduler)    │    │
│  └──────────────┬──────────────────────────┘    │
│                 │                               │
│  ┌──────────────▼──────────────────────────┐    │
│  │         Local Postgres                   │    │
│  │  items, stock, orders,                   │    │
│  │  order_items, payments                   │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │      Card Terminal (SumUp / Stripe)      │    │
│  │      Local USB or network connection     │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │           Receipt Printer                │    │
│  │           Local USB/serial               │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
         │ (optional, async, when internet available)
         ▼
  Central Reporting System
  (sales data, inventory sync)
```

---

## What Was Explicitly Rejected and Why

| Rejected | Reason |
|---|---|
| Kafka / message broker | Scale doesn't justify it. 200-500 orders/day needs no event streaming. |
| Redis cache | Menu fits in memory of any process. 100 items need no distributed cache. |
| Microservices | One small service does everything. Splitting adds deployment complexity with no benefit. |
| API Gateway | No external traffic. No rate limiting needed. No SSL termination needed at this scale. |
| JWT / Auth layer | No user accounts. Anonymous sessions eliminate the entire auth concern. |
| Saga pattern | Everything in one database. ACID transactions replace distributed sagas. |
| SQLite | Doesn't support `SELECT FOR UPDATE`. Concurrent write access (totem + admin) would serialize. |
| NUMERIC/DECIMAL for prices | Replaced by BIGINT cents. Exact integer arithmetic, no rounding errors. |
| Sharding | Last resort for scale. Not remotely needed here. |
| Optimistic locking for stock | Conflict probability too high for small stock quantities. Pessimistic is correct. |

---

## When to Revisit This Architecture

This design is intentionally simple. Graduate to a distributed architecture when:

```
Multiple locations       → central inventory service + event sync between totems
User accounts needed     → add auth layer, loyalty service, user database
High concurrent users    → more than one screen per location
Remote management        → centralized menu/stock management across locations
Analytics at scale       → Kafka + ClickHouse for event stream processing
```

Each of these is an additive change, not a rewrite. The core data model remains valid.

---

## Tech Stack Summary

```
Language:     Kotlin
Framework:    Spring Boot
Database:     PostgreSQL (local)
ORM:          Spring Data JPA + Hibernate (batch_size: 100)
Scheduler:    Spring @Scheduled (session expiry job)
Payment:      Stripe Terminal SDK or SumUp SDK
UI:           React (touch-optimized)
Receipt:      ESC/POS printer library (local USB)
```
