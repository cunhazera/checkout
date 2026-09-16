# Self-Checkout Totem — Implementation Plan (Node.js)

Companion to `snackbar_checkout_architecture.md`.

> **2026-09-14:** the single-location model below has been extended to many
> stores. Routes are now under `/v1/stores/:storeId`, and the schema is keyed by
> store. See `DISTRIBUTED_ARCHITECTURE.md`; the phases below remain the history
> of how the single-store version was built. That document is the source of truth
for **what** the system does; this one defines **how** it gets built on Node.js.

---

## 0. Stack translation (deviation from the arch doc)

The architecture document specifies **Kotlin / Spring Boot**. This project is Node.js.
Every ADR survives the translation unchanged — none of them depend on the JVM. The
mapping:

| Arch doc | Node.js equivalent | Note |
|---|---|---|
| Kotlin | TypeScript (strict) | Needed for the `_cents` discipline of ADR-005 |
| Spring Boot | Fastify | Lighter, faster startup on a totem; good TS types |
| Spring Data JPA / Hibernate | `pg` (node-postgres) + raw SQL | See below |
| Spring `@Scheduled` | `node-cron` in-process | Single machine, single process (ADR-001) |
| Stripe Terminal / SumUp SDK | Same SDKs (Node versions) behind a `PaymentTerminal` port | Fake driver first |
| React touch UI | React + Vite | Unchanged |
| ESC/POS printer lib | `node-escpos` / `escpos-usb` behind a `ReceiptPrinter` port | Fake driver first |

**No ORM.** ADR-004 requires `SELECT ... FOR UPDATE` with precise transaction control,
and every write path in the arch doc is already written as explicit SQL. An ORM would
add a translation layer over SQL we already have. Use `pg` with hand-written queries and
a thin `withTransaction(fn)` helper.

Verified locally: Node v25.4.0, npm 11.7.0, PostgreSQL 18.4, Docker 29.4.0.

### The one Node-specific hazard: BIGINT

`node-postgres` returns `BIGINT` (`int8`) as a **string**, because it does not fit in a
JS `number` safely. ADR-005 stores every monetary value as `BIGINT` cents.

Decision: register a type parser at startup that converts `int8` to a JS `number`, and
guard it.

```ts
// src/db/types.ts
import pg from 'pg';
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${v}`);
  return n;
});
```

`Number.MAX_SAFE_INTEGER` is ~9e15 cents = R$ 90 trillion. A snack bar will not reach it,
and the guard turns any violation into a loud crash rather than silent corruption.
All arithmetic stays in integer cents; division by 100 happens only in React render code.

---

## 1. Project layout

```
checkout/
├── snackbar_checkout_architecture.md
├── IMPLEMENTATION_PLAN.md
├── docker-compose.yml              # local Postgres
├── package.json                    # npm workspaces
├── packages/
│   ├── api/
│   │   ├── src/
│   │   │   ├── server.ts           # Fastify bootstrap
│   │   │   ├── config.ts           # env parsing, fails fast
│   │   │   ├── db/
│   │   │   │   ├── pool.ts         # pg.Pool + withTransaction
│   │   │   │   ├── types.ts        # int8 parser
│   │   │   │   └── migrations/     # 001_init.sql, ...
│   │   │   ├── routes/
│   │   │   │   ├── menu.ts
│   │   │   │   ├── session.ts
│   │   │   │   └── orders.ts
│   │   │   ├── services/
│   │   │   │   ├── menu.service.ts
│   │   │   │   ├── stock.service.ts     # reservation logic
│   │   │   │   ├── order.service.ts
│   │   │   │   └── payment.service.ts
│   │   │   ├── ports/
│   │   │   │   ├── payment-terminal.ts  # interface + fake + stripe impl
│   │   │   │   └── receipt-printer.ts   # interface + fake + escpos impl
│   │   │   ├── jobs/
│   │   │   │   └── session-cleanup.ts   # every 60s
│   │   │   └── money.ts                 # Cents branded type
│   │   └── test/
│   └── totem/                      # React + Vite touch UI
│       └── src/
│           ├── screens/            # Welcome, Menu, Cart, Paying, Result
│           ├── state/              # cart + session store
│           └── api/                # typed client
└── seeds/
    └── menu.sql                    # ~20 demo snack items + stock
```

Two workspaces, one repo, one `npm run dev` that starts both. This respects ADR-001 —
it is not microservices, just a client and a server that must be separate processes anyway.

---

## 2. Enforcing the cents discipline (ADR-005)

The arch doc says "a lint rule or custom type wrapper enforces this at compile time."
In TypeScript, a branded type does it with zero runtime cost:

```ts
// src/money.ts
export type Cents = number & { readonly __brand: 'Cents' };

export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) throw new Error(`Cents must be integer, got ${n}`);
  return n as Cents;
};

export const addCents = (a: Cents, b: Cents): Cents => (a + b) as Cents;
export const multiplyCents = (a: Cents, qty: number): Cents => (a * qty) as Cents;
```

A `Cents` cannot be passed where a count is expected and vice versa. Formatting
(`formatBRL`) lives only in the `totem` package. Add an ESLint rule banning the literal
`/100` inside `packages/api`.

---

## 3. Build phases

Each phase ends in a demonstrable, testable state. Phases are ordered so that the
riskiest logic (stock reservation) is proven before any UI exists.

### Phase 1 — Foundation
**Goal:** Postgres running, schema applied, server answers a health check.

- `docker-compose.yml` with `postgres:18` on port 5432, named volume for persistence.
- `packages/api` scaffold: TypeScript strict, Fastify, `pg`, `vitest`.
- Migration runner: plain `.sql` files applied in order, tracked in a
  `schema_migrations` table. No migration framework — this is a handful of files.
- `001_init.sql` = the schema from the arch doc, verbatim, including all `CHECK`
  constraints and indexes. The `CHECK (quantity >= reserved)` constraint is the last
  line of defence for ADR-004 and must not be dropped.
- `seeds/menu.sql` with ~20 snack items and stock rows (deliberately include items with
  `quantity = 1` and `quantity = 0` to exercise the edge cases).
- `GET /health` verifies DB connectivity.

**Done when:** `docker compose up -d && npm run migrate && npm run seed && npm run dev`
gives a `200` on `/health` from a clean checkout.

### Phase 2 — Menu (read path)
**Goal:** `GET /menu` per the arch doc.

- `menu.service.ts` runs the documented JOIN, computes `availableQuantity = quantity - reserved`,
  flags `outOfStock` when it hits 0.
- 10-second in-process cache (`Map` + timestamp). ADR-001/Redis-rejection means this is a
  plain object in memory, not a cache server. **Invalidate the cache on every stock write**
  — a 10s stale menu after a sellout is exactly the "item sells out while in cart" bug.
- Response shape returns `priceCents` (never a formatted string).

**Done when:** menu returns seeded items with correct availability; integration test
asserts a reserved item drops its available count.

### Phase 3 — Session + order creation with stock reservation ⚠️ core risk
**Goal:** `POST /session/start` and `POST /orders`.

- `POST /session/start`: generate UUID, return `{ sessionId, expiresAt: now + 15min }`.
  **No DB write** — per the arch doc, the session materialises only with the order.
- `POST /orders` implements the documented transaction exactly:
  - `BEGIN`
  - lock stock rows with `SELECT quantity, reserved FROM stock WHERE item_id = $1 FOR UPDATE`
  - **Sort the requested item IDs before locking.** The arch doc's pseudocode iterates in
    request order; with two concurrent carts holding overlapping items that deadlocks.
    A consistent lock order removes the cycle. This is an addition, not a contradiction.
  - if `quantity - reserved < requested` → `ROLLBACK`, `409 { error: 'item_out_of_stock', itemId }`
  - `UPDATE stock SET reserved = reserved + $n`
  - snapshot `unit_price_cents` from `items` **inside the transaction** (price at time of order)
  - insert `orders` (`expires_at = NOW() + INTERVAL '15 minutes'`) and `order_items`
  - `COMMIT` → `201 { orderId, totalCents, expiresAt }`
- `total_cents` is computed server-side from the snapshotted prices. The client's idea of
  the total is never trusted.
- `DELETE /orders/:id/abandon`: release reservations, set status `cancelled`.

**Tests (this is where the real testing effort goes):**
- concurrent `POST /orders` for the last unit → exactly one 201, one 409, `reserved` correct
- interleaved orders with overlapping item sets in opposite request order → no deadlock
- rollback leaves `reserved` untouched (no partial reservation)
- unknown/inactive item → 400/409, nothing reserved

**Done when:** a concurrency test hammering the last sandwich never oversells.

### Phase 4 — Payment (ADR-003)
**Goal:** `POST /orders/:orderId/pay` with the full three-outcome state machine.

- Define the port first:
  ```ts
  interface PaymentTerminal {
    charge(req: { amountCents: Cents; idempotencyKey: string })
      : Promise<{ status: 'succeeded' | 'failed'; providerPaymentId?: string }>;
    getStatus(idempotencyKey: string)
      : Promise<'succeeded' | 'failed' | 'unknown'>;
  }
  ```
- `FakeTerminal` driven by env/config to produce success, decline, timeout, or
  "timeout then resolves on the 3rd poll". Every payment path is developed and tested
  against it; the real SDK arrives in Phase 7 without touching `payment.service.ts`.
- Flow per the arch doc: validate order is `pending` and not expired → generate
  `idempotency_key = pay_{orderId}_{attempt}` → insert `payments` row → call terminal.
  - **SUCCESS:** one transaction — payment `succeeded`, order `paid`, and for each line
    `quantity -= qty, reserved -= qty`. Physical decrement happens only here (ADR-004).
  - **FAILURE:** payment `failed`, order `failed`, release `reserved`. Retry allowed:
    a new attempt gets attempt number + 1, so a new idempotency key.
  - **UNKNOWN:** payment `unknown`, **do not touch stock**, poll `getStatus` every 2s for
    up to 30s. Resolve as success/failure if it lands; otherwise leave `unknown` and
    return the order ID for staff. Never guess. The reservation stays held on purpose —
    releasing it could oversell an item that was in fact paid for.
- The 30s poll happens inside the request (ADR-003 requires a synchronous answer), so set
  the Fastify route timeout above 30s explicitly.
- `GET /orders/:orderId` for the UI to re-read state.

**Done when:** all four terminal behaviours produce the correct DB end state, verified by
integration tests asserting `stock`, `orders`, and `payments` rows.

### Phase 5 — Session expiry job
**Goal:** the 60-second reaper from the arch doc.

- `node-cron` every 60s: select `pending` orders past `expires_at`, and per order in one
  transaction release each line's `reserved` and set status `expired`.
- Lock the order row `FOR UPDATE` and re-check status inside the transaction, so the job
  cannot race a payment that is in flight for the same order.
- Log every release. This job silently returning stock is the thing most likely to hide a
  bug, so it must be observable.

**Done when:** a test inserts an order with `expires_at` in the past, runs the job once,
and asserts stock is returned and status is `expired`.

### Phase 6 — Totem UI
**Goal:** the full touch flow: Welcome → Menu → Cart → Paying → Result.

- React + Vite, touch-first: large tap targets (min 64px), no hover states, no keyboard.
- Screens:
  - **Welcome** — "Touch to start", calls `/session/start`.
  - **Menu** — grid of items with image, name, price, `+` control. Out-of-stock items are
    visibly disabled, not hidden. Poll `/menu` every 10s so availability stays live.
  - **Cart** — line items, quantity adjust, total, "Pay" button.
  - **Paying** — non-dismissible. "Follow the instructions on the card reader."
    Shows "Confirming your payment..." during the unknown-state poll.
  - **Result** — success (receipt printing, auto-reset after 10s) or failure with retry.
- **Every row of the arch doc's edge-case table gets an explicit UI state.** Build a
  `<Message>` component keyed by error code so the copy lives in one file:
  `item_out_of_stock`, `card_declined`, `payment_unknown`, `printer_failed`,
  `session_expired`.
- Inactivity: 2 minutes without touch → "Are you still there?" → 30s no response →
  `DELETE /orders/:id/abandon` → reset to Welcome.
- Cart reconciliation: if `POST /orders` returns 409, remove the offending item and show
  "[Item] just sold out and was removed from your order" rather than failing the whole cart.

**Done when:** a full purchase runs end to end on the fake terminal, and each edge case
can be triggered from the fake driver's config.

### Phase 7 — Hardware integration
**Goal:** replace the fakes.

- `ReceiptPrinter` port + ESC/POS implementation. Printer failure must **never** fail a
  paid order — catch, log, and show the QR fallback from the edge-case table.
- Real `PaymentTerminal` (Stripe Terminal or SumUp — vendor choice still open). Implement
  against the port defined in Phase 4; no service code changes.
- Kiosk boot: systemd/launchd units for Postgres, API, and Chromium in kiosk mode.

**Done when:** a real card charge completes and a physical receipt prints.

---

## 4. API surface (complete)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | DB connectivity |
| `GET` | `/menu` | Items with availability, 10s cache |
| `POST` | `/session/start` | Anonymous session ID + TTL |
| `POST` | `/orders` | Create order, reserve stock (409 on conflict) |
| `GET` | `/orders/:id` | Current order state |
| `POST` | `/orders/:id/pay` | Synchronous payment (ADR-003) |
| `DELETE` | `/orders/:id/abandon` | Cancel, release reservations |

No auth on any route (ADR-002). Bind the API to `127.0.0.1` only — it is reachable solely
from the totem's own browser, which is why no auth layer is needed. Binding to `0.0.0.0`
would turn "no auth" from a sound decision into an open door.

---

## 5. Testing strategy

- **Unit** (`vitest`): money arithmetic, totals, state-machine transitions.
- **Integration** (real Postgres in Docker, not a mock): every route, every flow above.
  Each test runs in a transaction that rolls back, except concurrency tests which need
  real committed state.
- **Concurrency** (the ones that actually matter): parallel order creation on scarce
  stock; deadlock probe with reversed item order; expiry job racing a payment.
- **Invariant check** usable as a test assertion and as a production health probe:
  `SELECT * FROM stock WHERE reserved < 0 OR quantity < reserved` must always be empty,
  and `reserved` must equal the sum of quantities across `pending` orders.

---

## 6. Open questions

1. **Card terminal vendor** — Stripe Terminal or SumUp? Affects Phase 7 only; the port
   abstraction means Phases 1-6 proceed without the answer.
2. **Admin surface for stock** — the arch doc mentions "admin dashboard" as a reason to
   choose Postgres over SQLite (ADR-006) but never specifies it. Assumed out of scope
   here; restocking is `psql` until asked otherwise.
3. **Receipt content** — legal/fiscal requirements for Brazil (NFC-e?) are not covered by
   the arch doc and may be a real constraint. Flagging early since it could affect the
   payment flow, not just the printer.
4. **Central reporting sync** (ADR-007, "optional") — not planned here. The `orders` table
   is the source of truth and a sync job can be added later without schema changes.

---

## 7. Suggested execution order

Phases 1-3 are the foundation and contain all the real risk — do them first and do not
compress Phase 3's concurrency tests. Phase 4 can begin as soon as Phase 3's tests pass.
Phase 6 (UI) can start in parallel with Phase 5 against the real API. Phase 7 waits on
hardware and the vendor decision.
