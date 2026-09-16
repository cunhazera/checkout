# Snack Bar self-checkout

A self-service checkout totem for snack bars. A customer walks up, taps the
items they want, pays by card, and leaves. No cashier, no login, no accounts.

Built from an architecture reference for a single shop, then extended to run
many stores from one application.

<p align="center">
  <img src="docs/screenshots/front.png" alt="Welcome screen: the idle state a customer walks up to" width="330">
  &nbsp;&nbsp;
  <img src="docs/screenshots/menu.png" alt="Product grid, with one item sold out and the basket bar at the bottom" width="330">
</p>

## What it does

The customer sees five screens: **welcome → products → basket → pay → result**,
plus a confirm sheet that guards against mis-taps. Behind that:

- **Stock is held, not just counted.** Adding to the basket reserves nothing;
  committing to pay reserves the units, and only a successful payment takes them
  off the shelf. Five totems in one shop can never sell the same last sandwich.
- **Payments have three outcomes, not two:** paid, declined, and *we don't
  know*. The third is never guessed at — the order is held, the customer is
  given a reference, and the system keeps asking the gateway until it has an
  answer.
- **A crash cannot lose a payment.** The intent is recorded before the gateway
  is called, and a background job finishes any attempt that was interrupted.
- **Abandoned baskets return their stock** automatically.
- **Each store has its own prices, currency, tax rate and language.** A São
  Paulo totem shows "R$ 12,90" and Portuguese copy; a US one shows "$2.40" and
  English.

## How it is put together

```
packages/totem     React kiosk UI (1080x1920 portrait)
       │  HTTP
packages/api       Fastify + Postgres: catalog, stock, orders, payments
       │  HTTP
packages/gateway   Mock card processor for development and tests
```

| Package | What it is |
|---|---|
| `packages/api` | The whole backend. Store-scoped REST under `/v1/stores/:storeId`. |
| `packages/totem` | The touch UI, built on the "Organic" design system from the handoff. |
| `packages/gateway` | A stand-in for Stripe/SumUp that can decline, time out, drop connections or answer nonsense on demand. Development only. |

## Running it

### You will need

- **Node 22.9 or newer** (`node -v`)
- **Docker**, for Postgres

### First run

```bash
git clone git@github.com:cunhazera/checkout.git
cd checkout

docker compose up -d      # Postgres on port 5433
npm install
npm run migrate           # create the schema
npm run seed              # two demo stores, five totems each
npm run dev               # gateway :3220, API :3210, totem :5180
```

Open **<http://127.0.0.1:5180>** and tap the screen.

The browser window shape matters: the UI is designed for a 1080×1920 portrait
panel and scales to fit, so a tall narrow window looks like the real thing.

### Day to day

| Command | What it does |
|---|---|
| `npm run dev` | Everything, with the in-process fake payment terminal |
| `npm run dev:gateway-payments` | Everything, with payments going over HTTP to the mock gateway |
| `npm test` | All 148 tests (API + totem) |
| `npm run typecheck` | All three packages |
| `npm run build` | Production build of the totem |
| `npm run seed` | Reset the demo data |

`npm run dev` starts three processes in one terminal and stops them together
with Ctrl-C.

## Trying the failure cases

This is the interesting part. Start the stack with payments going through the
mock gateway, then change how it behaves between purchases:

```bash
npm run dev:gateway-payments

npm run scenario                                  # list every scenario
npm run scenario declined_insufficient_funds      # card declined
npm run scenario -- network_error --failures 2    # connection drops twice, then works
npm run scenario -- timeout_then_approved --settle 8000
npm run scenario -- --charges                     # what the gateway thinks it charged
npm run scenario -- --reset
```

Then buy something and watch the totem handle it. `timeout_then_approved` is
the one worth seeing: the gateway takes longer than the 15-second timeout but
*does* charge the card, and the checkout has to discover that rather than
assume failure.

**Note the `--`.** Without it `npm run` swallows flags like `--failures`.

Full scenario list and what each should do: **[PAYMENT_TESTING.md](PAYMENT_TESTING.md)**.

## Testing

```bash
npm test              # everything
npm run test:api      # 126 tests, needs Postgres running
npm run test:totem    # 22 tests, no database needed
```

The API tests run against a **real Postgres**, not a mock, because the things
most worth testing — row locks, `SERIALIZABLE` retries, `FOR UPDATE SKIP
LOCKED` — do not exist in a fake. They cover concurrency (two customers racing
for the last unit), crash recovery (the process killed mid-payment), and every
way a payment gateway can misbehave.

CI runs all of this on every push, against a Postgres service container.

## Configuration

Copy `packages/api/.env.example` to `packages/api/.env` to override anything.
The defaults work out of the box.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://checkout:checkout@localhost:5433/checkout` | |
| `PORT` | `3210` | API port |
| `PAYMENT_DRIVER` | `fake` | `fake` (in-process) or `http` (the gateway) |
| `PAYMENT_HTTP_TIMEOUT_MS` | `15000` | After this, the outcome is *unknown*, never *failed* |
| `ORDER_TTL_MINUTES` | `15` | How long a basket holds its stock |
| `DB_POOL_MAX` | `20` | Connections per API instance |

Ports: Postgres `5433`, API `3210`, gateway `3220`, totem `5180`. Nothing binds
to the default 5432 or 3000, which are commonly taken.

### Seeded data

| Store | Currency | Totem `T1` |
|---|---|---|
| `LOCAL-0001` | USD | `b0000000-0000-4000-8000-000000000001` |
| `BR-SP-0001` | BRL | `b0000000-0000-4000-8000-000000000011` |

Store ids are `a0000000-…-000000000001` and `…002`. To run the totem as the
Brazilian store — Portuguese copy, BRL prices, a smaller product range:

```bash
VITE_STORE_ID=a0000000-0000-4000-8000-000000000002 \
VITE_TOTEM_ID=b0000000-0000-4000-8000-000000000011 \
npm run dev:totem
```

Stock is seeded deliberately uneven: one item has a single unit left and one is
sold out, so the interesting paths are reachable immediately.

## Design decisions worth knowing

- **Money is always integer cents**, never floating point, and always carries
  its currency.
- **Stock uses pessimistic locking** (`SELECT … FOR UPDATE`) under
  `SERIALIZABLE`. Overselling a physical sandwich is unacceptable, and conflicts
  are likely when the last two are on the shelf.
- **Every table a store owns is keyed by `(store_id, …)`**, so stores can be
  split across database shards later without distributed transactions.
- **Prices are snapshotted onto the order.** A price change never rewrites what
  a customer was charged.
- **The payment gateway is called between transactions, never inside one**, so a
  slow processor cannot hold database locks.

## Documentation

| Document | What's in it |
|---|---|
| [snackbar_checkout_architecture.md](snackbar_checkout_architecture.md) | The original architecture reference and its ADRs |
| [DISTRIBUTED_ARCHITECTURE.md](DISTRIBUTED_ARCHITECTURE.md) | Going from one shop to thousands: data model, API, and the phased plan |
| [PAYMENT_TESTING.md](PAYMENT_TESTING.md) | Every payment failure and how to reproduce it |
| [PROGRESS.md](PROGRESS.md) | What is built, decisions taken, measurements, and what is still open |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | How the first version was planned |

## Troubleshooting

**"Cannot reach the checkout service" on the totem.** The API is not running,
or it is on a different port from the one the totem proxies to
(`packages/totem/vite.config.ts`).

**`Port 3210 is already in use`.** Something else has it: `PORT=3299 npm run
dev:api`, and point the totem at it with `VITE_API_TARGET`.

**The container exits on start.** Postgres 18 stores data at
`/var/lib/postgresql`, not `/data`. If you changed the compose file, that is
usually why.

**Tests fail with connection errors.** `docker compose up -d`, then
`npm run migrate`. The tests re-seed the database as they run, so a `npm test`
will reset whatever demo data you were looking at.

## Not built yet

Honest list: no authentication or TLS (the API binds to localhost only, and the
architecture doc explains when that stops being enough), no real card reader, no
refund path, no admin screens for opening a store, no receipt QR generation, and
product names come from a single-language catalog. Tax is configured at 0 for
both demo stores.
