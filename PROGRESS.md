# Build Progress

Tracks what is actually built against `IMPLEMENTATION_PLAN.md` and
`snackbar_checkout_architecture.md`. Status: ✅ done · 🚧 in progress · ⬜ not started

_Last updated: 2026-09-13_

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation — Postgres, schema, migrations, health | ✅ |
| 2 | Menu read path | ✅ |
| 3 | Session + order creation with stock reservation | ✅ |
| 4 | Payment state machine | ✅ |
| 5 | Session expiry job | ✅ |
| 6 | Totem UI — screens wired to the live API | ✅ |
| 7 | Hardware integration (real terminal, printer, kiosk boot) | ⬜ |

## What exists

### Backend (`packages/api`)

| File | Purpose |
|---|---|
| `src/config.ts` | Env parsing, fails fast at startup |
| `src/money.ts` | `Cents` branded type, exact integer arithmetic (ADR-005) |
| `src/errors.ts` | `AppError` with stable machine-readable codes for the UI |
| `src/db/types.ts` | int8 → number parser with safe-integer guard |
| `src/db/pool.ts` | `pg.Pool` + `withTransaction` |
| `src/db/migrate.ts` | Ordered `.sql` runner, tracked in `schema_migrations` |
| `src/db/seed.ts` | Applies `seeds/menu.sql` |
| `src/db/migrations/001_init.sql` | The whole schema: stores, catalog, per-store products, stock, orders, payments, indexes |
| `src/services/menu.service.ts` | Menu query, read fresh every request (no cache) |
| `src/services/stock.service.ts` | `SELECT FOR UPDATE` reserve / release / commit (ADR-004) |
| `src/services/order.service.ts` | Session start, order creation, get, abandon |
| `src/services/payment.service.ts` | Three-outcome payment state machine (ADR-003) |
| `src/ports/payment-terminal.ts` | Hardware interface |
| `src/ports/fake-terminal.ts` | Dev/test driver: approve, decline, timeout, timeout-then-approve |
| `src/ports/http-terminal.ts` | Calls a real gateway over HTTP: timeout, retries, error classification |
| `src/jobs/session-cleanup.ts` | 60s expiry reaper |
| `src/jobs/payment-resolver.ts` | Finishes payment attempts a crash interrupted (the outbox relay) |
| `src/routes/*.ts` | health, menu, session, orders |
| `src/app.ts`, `src/server.ts` | Fastify factory + entrypoint |

### API surface

Store-scoped and versioned since 2026-09-14. The full mapping from the old
routes is in `DISTRIBUTED_ARCHITECTURE.md`.

| Method | Path |
|---|---|
| `GET` | `/health` |
| `GET` | `/v1/stores/:storeId` |
| `GET` | `/v1/stores/:storeId/menu` |
| `POST` | `/v1/stores/:storeId/sessions` |
| `POST` | `/v1/stores/:storeId/orders` |
| `GET` | `/v1/stores/:storeId/orders/:orderId` |
| `POST` | `/v1/stores/:storeId/orders/:orderId/payments` |
| `POST` | `/v1/stores/:storeId/orders/:orderId/cancel` |
| `GET` | `/v1/stores/:storeId/health/stock` |
| `GET` | `/v1/stores/:storeId/health/orders` |

### Frontend (`packages/totem`)

Tests: `src/money.test.ts`, `src/i18n.test.ts`, `src/state/session.test.tsx`
(22 in total) — cart maths, tax estimate, the sold-out 409 path, decline and
unknown payments, session reset, and translation.


| File | Purpose |
|---|---|
| `src/api/client.ts` | Typed fetch client; `ApiError` carries the server's `code` |
| `src/api/types.ts` | Wire types mirroring the API |
| `src/state/session.ts` | The whole session state machine + every API call |
| `src/money.ts` | The ONLY place cents are divided by 100 (ADR-005) |
| `src/data/presentation.ts` | Art palette + glyph per item, with a fallback for unknown ids |
| `src/screens/*.tsx` | Welcome, Shop, Review, Pay, Done |
| `src/components/*.tsx` | Art, Stepper, ConfirmSheet |
| `src/styles/styles.css` | The Organic token sheet, copied from the handoff |
| `src/styles/totem.css` | Screen styles, all values from the tokens |
| `vite.config.ts` | Dev server + `/api` proxy to the backend |

### Tests (`packages/api/test`)

- `money.test.ts` — cents arithmetic, tax rounding, rejection of floats
- `orders.test.ts` — reservation, rollback, price snapshot, abandon idempotency
- `concurrency.test.ts` — last-unit race, contention, **deadlock probe**
- `payment.test.ts` — all four terminal outcomes, retry, double-pay, expiry
- `cleanup.test.ts` — expiry reaper, paid-order safety, repeat runs
- `race.test.ts` — last-unit purchase races end to end, **concurrent double-tap
  payment idempotency**
- `gateway.test.ts` — 21 payment-gateway scenarios against the mock service:
  declines, >15s timeouts, network retries, idempotency (see PAYMENT_TESTING.md)
- `isolation.test.ts` — SERIALIZABLE is in force, retries replay contention,
  business failures are not retried, budget exhaustion surfaces
- `routes.test.ts` — full HTTP happy path and error codes

## How the frontend connects

The totem never talks to Postgres and never decides what is owed.

- **Dev:** Vite serves the UI on `127.0.0.1:5180` and proxies `/api/*` to the API
  on `127.0.0.1:3210`. The API stays bound to loopback — ADR-002 removed the
  auth layer, which is only sound while the totem's browser is the sole client.
- **Cart lives client-side** until the customer commits. The order is created —
  and stock reserved — on the Review screen's "Pay" button, not earlier. Holding
  a reservation through browsing would block other customers for no reason.
- **Totals:** the basket screen shows a client-side *estimate* using
  `/config`'s tax rate. The moment the order exists, the server's
  subtotal/tax/total replace it. The client's number is never authoritative.
- **409 reconciliation:** if an item sold out while the cart sat there, the line
  is dropped and the customer is returned to the basket with the design's
  "just sold out and was removed from your order".
- **Abandonment:** Cancel, the inactivity reaper, and "Done" all call
  `DELETE /orders/:id/abandon` so stock comes back immediately rather than
  waiting on the 60s expiry job.

## Decisions made during implementation

1. **Sorted lock acquisition.** The arch doc locks stock rows in request order;
   two carts with overlapping items in opposite order would deadlock. Item IDs
   are sorted before locking. Covered by a test that fails without it.
2. **Unknown payment holds the reservation.** ADR-003 says never assume success
   or failure. Releasing stock on an unresolved payment could oversell an item
   that was actually charged, so the reservation stays until a human reconciles
   or the TTL passes. The arch doc does not specify this.
3. **Duplicate lines rejected.** Two lines for the same item would take the same
   lock twice and double-reserve. The client merges them into one quantity.
4. **Expiry re-checks under a row lock.** The arch doc scans then updates; the
   lock closes the window where the reaper races an in-flight payment.
5. **Charge happens outside the transaction.** Holding a DB transaction across a
   30s hardware round-trip would pin stock locks for the duration.
6. **The schema lives in one migration.** Nothing is deployed, so `001_init.sql`
   is rewritten to the final shape instead of being amended; `002`–`004` were
   folded into it on 2026-09-15.
7. **Sold-out tiles are disabled, not hidden.** The design has no stock concept
   at all; the arch doc's edge-case table requires the state. Tiles show
   "Sold out", and "All in basket" when the cart already holds every unit.
8. **No "Simulate failure" button.** The design marks it a debug affordance that
   must not ship. The same path is exercised with `FAKE_TERMINAL_MODE=decline`
   on the backend, which cannot leak into a live totem.
9. **Art direction lives in the frontend.** Glyphs and palettes are keyed by item
   id in `presentation.ts`, with a hash fallback for items added later. The
   stock database has no business storing art.

## Bug found and fixed: double payment on a double-tap

`payOrder` set the order to `paid` only *after* the terminal returned. During
the charge the order was still `pending`, so a second concurrent request passed
the same `status !== 'pending'` gate and **charged the card twice**. On a touch
kiosk a double-tap on "Pay" is the obvious way to trigger it.

The fix uses `confirmed` — the payment-in-flight state that was already in the
arch doc's status enum but unused. The order leaves `pending` inside the same
transaction that takes the row lock, before the terminal is ever called, so the
second request is rejected with `order_not_pending`.

Verified by removing the claim and re-running: two charges instead of one.

This also fixed a contradiction. An unresolved (`unknown`) payment previously
left the order `pending`, which meant the expiry reaper would release its stock
once the TTL passed — despite the code's own comment saying the hold survives
until a human reconciles. Such orders now sit in `confirmed`, which the reaper
skips, and `GET /health/orders` lists them so staff can find them.

**Operational consequence:** if the process dies mid-charge, its order stays
`confirmed` and holds stock indefinitely. That is deliberate — releasing it
could oversell an item the customer paid for — but it needs a human. That is
what `/health/orders` is for.

## Transaction isolation: SERIALIZABLE

`withTransaction` opens every transaction with
`BEGIN ISOLATION LEVEL SERIALIZABLE` (`src/db/pool.ts`). Postgres then
guarantees the result matches *some* serial order of the concurrent
transactions, including rows this code never thought to lock — correctness stops
depending on remembering a `FOR UPDATE`.

**The cost:** SERIALIZABLE aborts a contending transaction (SQLSTATE `40001`)
instead of queuing it, so every write path needs a retry. That retry lives in
`withTransaction`, not in each service, and is safe because a rolled-back
transaction leaves no partial effect. The hard rule it depends on: **the
callback must have no side effects outside the transaction.** The payment flow
already calls the terminal *between* transactions, never inside one.

- Default budget is **10 retries** with full jitter. At 5, a deliberately
  adversarial 12-cart pile-up on two rows still surfaced raw `40001`s.
- Post-charge settlement gets **20**, because losing that write means money
  moved with no record of it.
- The explicit `FOR UPDATE` locks are **kept**. They turn most contention into a
  short wait instead of an abort-and-replay, so retries stay rare.

**The lock ordering now matters for speed, not just correctness.** Retries will
push a deadlocked set through regardless, so a passing test no longer proves the
ordering is right. Postgres waits out `deadlock_timeout` (1s) before it even
looks for a cycle, so the cost is what gives it away — measured here at ~250ms
with sorted locks versus ~8.4s without. The deadlock test asserts elapsed time
under 3s for exactly this reason; with sorting removed it fails at ~16s.

## Connection pool review (2026-09-15)

`pool.ts` was written for one totem on one machine (`max: 10`, "1-3 concurrent
users"). Reviewed against thousands of totems on one API.

**The pool was never the throughput limit.** Measured against the real HTTP
path, `waiting` stayed at 0 in every run, even at 5 connections. What does limit
throughput is row contention under SERIALIZABLE — and a *bigger* pool makes that
worse, because more conflicting transactions run at once:

| Load (400 sales, 60 concurrent) | Pool | Throughput | p95 | Contention give-ups |
|---|---:|---:|---:|---:|
| Spread over 50 stores | 20 | **337 sales/s** | 325 ms | 0 |
| All on one store | 20 | 222 sales/s | 825 ms | 3 |
| All on one store | 5 | 312 sales/s | 309 ms | 0 |

Which matches the architecture: contention is partitioned by store, and a real
store has 5 totems, not 60. The pool is a safety valve, not a throughput lever —
so it stays modest and the system scales out by instances and shards.

### Fixed

1. **Retries held their connection through the backoff.** `release()` sat in
   `finally`, which runs after the `catch` that sleeps. Under contention,
   retrying transactions starved every other query: an unrelated read waited
   55 ms on a pool of 4, versus 2 ms once the sleep moved outside. Guarded by a
   test that fails against the old shape.
2. **An exhausted pool queued forever** — no `connectionTimeoutMillis`, so a
   request waited indefinitely and the totem showed a spinner. Now fails fast as
   `503 database_busy`.
3. **An idle connection failing crashed the process.** Postgres emits `error` on
   the pool; unhandled, it takes Node down. Now logged, connection discarded.
4. **No statement or idle-in-transaction timeout**, so one stuck query could
   hold a connection forever and drain the pool a slot at a time. Both set.
5. **Contention exhaustion surfaced as a 500.** It is transient and safe to
   retry, so it is now `503 database_busy` with `reason: 'contention'`.
6. Added `keepAlive`, connection recycling (`maxLifetimeSeconds`),
   `application_name` for `pg_stat_activity`, and pool stats on `/health` so
   saturation is visible (`waiting > 0`).

`DB_POOL_MAX` defaults to 20 and is configurable. The number that matters is
instances x DB_POOL_MAX against Postgres `max_connections`; past a few
instances, add PgBouncer rather than raising it.

## Open decisions (need your call)

1. **Tax.** The design shows "Tax (8%)"; the arch doc has no tax concept.
   Implemented as `TAX_BASIS_POINTS`, **defaulting to 0** (prices tax-inclusive).
   Set to `800` for 8%. Needs whoever owns pricing to confirm.
2. **Payment methods.** Design offers card / wallet / QR; arch doc assumes one
   card terminal. `payments.method` records the choice, but all three currently
   route to the same terminal port.
3. **Receipt.** Design says QR-only, "Nothing is printed." Arch doc Phase 7 has
   an ESC/POS printer. Nothing built yet either way.
4. **Card terminal vendor** — Stripe Terminal vs SumUp. Blocks Phase 7 only.

## Not built

- Real terminal driver, receipt printer, kiosk boot (Phase 7)
- Frontend tests — the backend has 40; the UI has none yet
- Self-hosted fonts. `styles.css` still `@import`s Google Fonts, which will fail
  on an offline kiosk. `packages/totem/public/fonts/` is waiting for the files.
- A real QR code on the receipt (currently the design's drawn stand-in)
- Admin/restock surface — out of scope per the plan; restock via `psql`
- Central reporting sync (ADR-007, optional)

## Verification

Run from a clean checkout:

```bash
docker compose up -d
npm install
npm run migrate --workspace @checkout/api
npm run seed    --workspace @checkout/api
npm test        --workspace @checkout/api
PORT=3210 npm start --workspace @checkout/api
```

Last run: **40 tests passed** (6 files, 38s — 36s of that is the payment suite
genuinely waiting out the 30s unknown-state window).

The deadlock test was verified to actually catch its regression: with sorted
lock acquisition disabled, 10 of 12 concurrent orders fail with a Postgres
deadlock. It is a real guard, not decoration.

Live flow confirmed end to end: session → order (stock reserved, physical count
untouched) → pay → physical decrement, reservations cleared,
`GET /health/stock` reports `{"ok": true}`.

## Gotchas hit during setup

- **Postgres 18 changed its volume convention.** The mount must be at
  `/var/lib/postgresql`, not `/var/lib/postgresql/data`, or the container exits
  on boot. `docker-compose.yml` uses the new path.
- **Host port 5433**, not 5432 — something already occupies the default port on
  this machine, and so does **port 3000** (use `PORT=3210` or similar).
- **`node-cron` was dropped.** It ships no type declarations, and the cadence is
  a fixed 60 seconds, so `setInterval` with an overlap guard replaced it.

## Log

### 2026-09-12
- Scaffolded repo structure; copied `styles.css` into the totem package.
- Implemented Phases 1–5 of the backend; 40 tests passing against real Postgres.

### 2026-09-13
- Switched all transactions to SERIALIZABLE with a jittered retry wrapper
  (see above). 55 tests passing, stable across repeated runs.
- Found and fixed a double-charge race on concurrent payments (see above);
  added `race.test.ts` and `GET /health/orders`. 50 tests passing.
- Fixed the totem client sending `content-type: application/json` on bodyless
  requests, which broke "Touch to start"; server now tolerates an empty body.
- Fixed a port mismatch: the API defaulted to 3000 while the totem's proxy
  targeted 3210, so `npm run dev` left Vite up with a dead backend. Both are
  3210 now, the root `dev` script tears down both processes together, and an
  in-use port produces an actionable error instead of a silent exit.
- Built Phase 6: the five screens plus the confirm sheet, wired to the live API.
- Added `GET /config` so tax rate and currency are not hard-coded in the client.
- Verified the full flow through the Vite proxy: config → menu → session →
  order (stock held) → pay → stock decremented, invariant clean. The sold-out
  409 and the decline path were both exercised end to end.

## Index tuning (2026-09-13)

Profiled against a disposable benchmark database — `docker compose --profile
bench up -d bench`, port 5434, no volume. Dataset: **500 products, 200k orders,
600k order lines, 180k payments** (~18 months at the arch doc's 200-500
orders/day), with only ~52 orders live at any moment, as the expiry reaper
guarantees.

### Result

| Query | Before | After |
|---|---:|---:|
| `GET /menu` | 0.81 ms | unchanged |
| `GET /orders/:id` header | 0.04 ms | unchanged |
| `GET /orders/:id` lines | 0.13 ms | unchanged |
| `reserveStock` row lock | 0.04 ms | unchanged |
| `payOrder` attempt count | 0.06 ms | unchanged |
| release/commit reservations | 0.09 ms | unchanged |
| expiry reaper scan | 0.12 ms | unchanged |
| **`GET /health/stock`** | **94 ms** | **0.98 ms** |
| **`GET /health/orders`** | **7.2 ms** | **0.21 ms** |

Every hot path was already correctly indexed by the arch doc's original schema.
The two health probes were the only problems, and both for the same reason:
nothing described *"orders that are currently live"*.

### One index, added

```sql
CREATE INDEX idx_orders_live ON orders(status, updated_at)
  WHERE status IN ('pending', 'confirmed');
```

`idx_orders_status` covers `status = 'pending'` only. Since the double-charge
fix an order mid-payment sits in `'confirmed'` and still holds stock, so both
have to be reachable. Partial keeps it to dozens of rows out of 200k rather
than a full index on a column that is ~60% `'paid'`.

### The bigger win was the query, not the index

`/health/stock` ran a correlated subquery per stock row: 500 items x 40 live
orders = **20,000 index scans, 138k buffers**, each discarding 3 rows by filter.
Rewritten as one aggregate joined to `stock`, driving from the tiny live-order
set. Fixing only the index left it at 10 ms; the rewrite took it to 0.98 ms.

Worth noting the correlated form got *worse* once `'confirmed'` was included —
**1165 ms** — because that status fell outside the partial index entirely. The
shape was hiding behind a lucky index.

### A correctness bug this surfaced

`/health/stock` counted only `'pending'` orders as holding stock. After the
double-charge fix, `'confirmed'` orders hold reservations too — so the probe
reported **33 items drifted** on data where nothing was actually wrong. It would
have cried wolf in production every time someone was mid-payment. Fixed to
count both.

`assertStockInvariant` in the test helpers had a related hole: it computed
`expected` and then never compared against it, so the "reserved matches live
orders" half of the invariant was never actually asserted. It is now.

### Deliberately not added: `order_items(item_id)`

An unindexed foreign key, which normally warrants fixing. But nothing deletes
or re-keys an item (the catalog soft-deletes via `items.active`), and with the
rewritten query driving from live orders, no query uses it. Measured at 4.3 MB
on 600k lines with a write cost on the hottest insert path in the system, for
zero read benefit. Add it when per-item reporting arrives.

### Reproducing

```bash
docker compose --profile bench up -d bench
DATABASE_URL=postgres://checkout:checkout@localhost:5434/checkout_bench \
  npx tsx packages/api/src/db/migrate.ts
# seed script: see the generator in this session's history
docker compose --profile bench down          # disposable, no volume
```

### 2026-09-14
- Installed Claude Code skills `node` and `fastify` into `.claude/skills/`, from
  `mcollina/skills` pinned at commit `856efd268ae8` (MIT). Reviewed before
  install: markdown plus example `.ts` only — no hooks, no plugin manifest, no
  tool permissions. To update, re-run the `codeload.github.com` tarball extract
  with a newer commit and review the diff.
- **Graceful shutdown** now uses `close-with-grace` (no dependencies of its own).
  It handles SIGINT/SIGTERM, `uncaughtException` and `unhandledRejection`.
  Cleanup is registered as a Fastify `onClose` hook: stop the expiry job
  (waiting for a sweep in progress), then close the pool. The time limit is the
  payment polling window + 15s, not the usual 10s, so a shutdown doesn't cut off
  a customer mid-payment. Verified: idle exit in 70ms; SIGTERM during a payment
  waited 4.6s and the customer still got a response; a second Ctrl+C exits 1
  without the old `Called end on pool more than once` crash; an unhandled
  rejection triggers a clean shutdown.
- **`.env` is now loaded** via `--env-file-if-exists=.env` in the dev, start,
  migrate and seed scripts (Node >= 22.9, declared in `engines`). Verified
  a missing file is fine and real environment variables win over the file.

### Evaluated, not applied: Node type stripping instead of tsx

Converted a copy of `packages/api` and measured it.

| | tsx (current) | node type stripping |
|---|---|---|
| Changes needed | — | 28 files, 222 lines: 85 import specifiers `.js`→`.ts`, 5 constructor parameter properties in 2 files, tsconfig, scripts |
| Typecheck | clean | clean, plus `erasableSyntaxOnly` so tsc rejects unstrippable syntax |
| Tests | 55/55 | 55/55 |
| Boot to listening | 671 ms | 207 ms |
| Processes | 3 (npx/tsx parent + node child) | 1 |
| Listening process RSS | 98 MB | 110 MB |
| Disk | — | ~21 MB less (tsx's esbuild 0.28; Vite keeps its own 0.21) |

The totem is unaffected: Vite compiles it, Node never runs it.

### 2026-09-14 — multi-store (Phase 0 of DISTRIBUTED_ARCHITECTURE.md)
- `stores`, `totems`, `store_items`; `store_id`
  first in every store-owned primary key and foreign key; price, currency and
  tax moved to the store.
- API moved under `/v1/stores/:storeId`; payments are a 201 collection; cancel
  is `POST .../cancel`. Old routes removed. `GET /config` and the
  `TAX_BASIS_POINTS` env var are gone.
- `FASTIFY_FIXES_PLAN.md` applied as part of the route rewrite.
- Totem reads its store and totem from `VITE_STORE_ID` / `VITE_TOTEM_ID`.
- Seed: two stores (USD and BRL), five totems each.
- 82 tests passing. Migration verified on 200k orders; store-scoped queries
  verified with 2,001 stores.

### 2026-09-15
- Folded migrations `002`–`004` into `001_init.sql`: while nothing is deployed,
  the schema is written from scratch rather than amended. Dev database dropped
  and rebuilt; the resulting primary keys, unique constraints, foreign keys,
  CHECKs and indexes match what the four migrations produced. 82 tests passing.

### 2026-09-15 — mock payment gateway
- New `packages/gateway`: a mock card processor with 14 scenarios (declines,
  timeouts that settle or never do, dropped connections, 500s, 429s, unreadable
  responses, currency rejection), switchable at runtime via `npm run scenario`.
- New `http` payment driver in the API, with a 15s per-attempt timeout and 2
  retries. It classifies failures by one question: did the request provably
  never reach the gateway? Refused connection → failed; timeout, reset, 5xx or
  unreadable body → unknown, never guessed.
- `ChargeRequest` now carries the store's currency.
- 103 tests passing (21 new). The suite also got faster: `vitest.config.ts`
  shortens the reconciliation window, so the run dropped from 38s to 22s.
- Verified live end to end, one purchase per scenario, through the totem proxy.
- Full guide: `PAYMENT_TESTING.md`.

### 2026-09-15 — payment recovery (the missing outbox relay)
- Reproduced the gap: killing the API mid-charge left the gateway holding an
  approved charge while the database said `order=confirmed payment=pending`,
  stock frozen, and nothing in the system would ever finish it.
- Added `jobs/payment-resolver.ts`: sweeps non-terminal payments past a grace
  period, asks the gateway by idempotency key, settles or releases,
  `FOR UPDATE SKIP LOCKED`, gives up after a budget and logs for a human.
- **Made settling idempotent** — stock now moves only on the real transition out
  of `confirmed`. Without this the resolver would have double-decremented stock;
  verified by removing the guard and watching the test (and the DB CHECK
  constraint) catch it.
- Guarded the terminal call: a driver that throws now records `unknown` instead
  of leaving the attempt `pending` and the exception to bubble up.
- Added `not_found` to the status lookup, so a crash *before* the request ever
  went out releases its stock instead of freezing it.
- `/health/orders` now also reports `chargedButNotPaid`: charges that succeeded
  for an order that was already released, which only a refund can fix.
- 114 tests passing (11 new). Verified live: the resolver recovered a stuck,
  genuinely-charged order 6s after restart.

### 2026-09-15 — connection pool
- Reviewed `pool.ts` for the multi-store scale; see "Connection pool review".
  Six fixes, 8 new tests (122 total), two of them verified to fail against the
  old behaviour.

### 2026-09-15 — project review follow-ups
- **Committed.** The repository had no commits at all; everything now tracked.
- **The totem was run and walked end to end in a browser** for the first time:
  welcome, grid, confirm sheet, basket, pay, result. It matches the design, and
  the only console error came from a browser extension, not the app.
- **22 frontend tests added** (there were none), covering cart maths, the
  sold-out reconciliation, decline/unknown payments and session reset.
- Four defects from the review fixed:
  1. `orders.currency` is now snapshotted, not read live from the store.
  2. Orders are capped at 50 lines and 99 per line — an unbounded list would
     take unbounded row locks in one transaction.
  3. An order that would cost nothing is refused, rather than sending a
     zero-amount charge a processor would reject.
  4. **Screen copy now follows the store's locale** (`src/i18n.ts`, en + pt-BR).
     A São Paulo totem said "Your basket" above "R$ 12,90"; verified in the
     browser that it now reads Portuguese throughout. Product names still come
     from the single-language catalog — that remains a Phase 4 item.
- **CI added** (`.github/workflows/ci.yml`): typecheck, API tests against a real
  Postgres service, totem tests, totem build.
- 148 tests in total (126 API + 22 totem).

### 2026-09-17 — store-owned products
Spec: `.claude/specs/store-owned-products.md`, from an interview after the
premortem. Implemented in full.
- `items` + `store_items` collapse into one **`products`** table keyed
  `(store_id, id)`, holding name, description, image, price and `active`. There
  is no shared catalog: a totem is filled from a local shelf, so each store owns
  its rows, and a product id from another store does not resolve at all.
- `products.active` is the only off switch and it is per store. The global
  switch that could empty every menu in the country no longer exists — the
  earlier mitigation (a rule forbidding it) is now unnecessary.
- `stock` and `order_items` key off `product_id`; the API field is `productId`
  and the error codes are `product_out_of_stock` / `product_unavailable`.
- **The menu cache was removed.** Availability is read from the database on
  every request, so it cannot go stale across API instances. The store settings
  cache (30 s) stays: it never affects stock.
- Seed now gives each store its own products — BR-SP-0001 sells Portuguese-named
  products at BRL prices, not translations of the other store's rows.
- 148 tests passing; verified end to end in the browser, including a store
  rejecting another store's product id.

### 2026-09-17 — the four gaps from the second review
- **Out-of-service screen.** With the API unreachable, tapping the totem used to
  do *nothing*: the error was written to state only the product grid rendered,
  and the grid is never reached from the welcome screen. There is now a screen
  that says so, it covers the unprovisioned device too, and the totem retries
  every 5s and comes back on its own.
- **Runtime totem identity.** `src/identity.ts` reads `/totem.json` at startup
  instead of the build baking in `VITE_STORE_ID`. Imaging a fleet would have
  given every device the same `totem_id`. The spec had said this since the
  premortem; the code now matches it.
- **Container images.** Dockerfiles for the API (compiled output, production
  deps, non-root, SIGTERM to PID 1), the totem (nginx, `/totem.json` served
  `no-store`, `/api` proxied with a 120s read timeout for the payment window),
  and the mock gateway, plus `docker-compose.prod.yml`. Verified by buying
  something with the whole system in containers.
- **Accessibility.** Product tiles carry a full label (name, size, price, sold
  out, quantity in basket); the status line, stepper count, payment spinner and
  result screen announce politely; both modals are dialogs; decorative art and
  the QR are hidden from screen readers; the welcome screen is keyboard
  operable; `<html lang>` follows the store's locale; animation respects
  `prefers-reduced-motion`. A public kiosk has legal requirements here
  (EN 301 549, ADA), so this is not polish.
- 11 new totem tests (33 total, 159 across the project). A build-only tsconfig
  keeps tests — which import the mock gateway — out of the production image.
