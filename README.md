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
- **One screen, one basket.** Starting an order closes that totem's previous
  unpaid one, so a customer who walks away doesn't hold stock while the next
  person is told it's sold out. A payment already in flight is never cancelled.
- **Payments have three outcomes, not two:** paid, declined, and *we don't
  know*. The third is never guessed at — the order is held, the customer is
  given a reference, and the system keeps asking the gateway until it has an
  answer.
- **A crash cannot lose a payment.** The intent is recorded before the gateway
  is called, and a background job finishes any attempt that was interrupted.
- **Abandoned baskets return their stock** automatically.
- **Each store owns its products outright** — its own rows, names, prices,
  currency, tax rate and language. A São Paulo totem sells "Batata frita" at
  "R$ 12,90" in Portuguese; a US one sells "Salted chips" at "$2.40". Nothing one
  store does can change what another sells.

## How it is put together

```
packages/totem     React kiosk UI (1080x1920 portrait)
       │  HTTP
packages/api       Fastify + Postgres: products, stock, orders, payments
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
| `npm test` | All 161 tests (API + totem) |
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

## The API

Everything a store owns lives under `/v1/stores/:storeId`. The store id is the
partition key, so no endpoint ever spans two stores and sharding stays open.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | Process and database liveness, with pool stats |
| `GET` | `/v1/stores/:storeId` | Store settings: currency, locale, tax rate |
| `GET` | `/v1/stores/:storeId/menu` | Products with live availability |
| `POST` | `/v1/stores/:storeId/orders` | Create an order and **reserve** the stock |
| `GET` | `/v1/stores/:storeId/orders/:orderId` | Read one order |
| `POST` | `/v1/stores/:storeId/orders/:orderId/payments` | Attempt payment |
| `POST` | `/v1/stores/:storeId/orders/:orderId/cancel` | Release the reservation |
| `GET` | `/v1/stores/:storeId/health/stock` | Stock invariant check |
| `GET` | `/v1/stores/:storeId/health/orders` | Payments that need a human |

Two things about this shape are worth knowing before reading it as ordinary CRUD.
**Payment answers `201` whatever the outcome** — the attempt really was created,
and `status` says whether the money moved (`succeeded`, `failed`, or `unknown`,
which is never guessed at). And **`cancel` is a verb on purpose**: orders are
financial records that are never deleted, so `DELETE` would misdescribe it.

The mock gateway adds `/charges`, `/charges/:key` and a `/control/*` surface for
choosing how it misbehaves. Development only.

**Every endpoint with a runnable `curl`: [API.md](API.md).**

## Running it in containers

```bash
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml exec api node packages/api/dist/db/migrate.js
docker compose -f docker-compose.prod.yml exec api node packages/api/dist/db/seed.js
```

**This replaces the development database container.** Both compose files define a
`db` service in the same project, so the second one to start takes the container
over — pointing it at the production volume and dropping the `5433` binding the
development setup uses. Your development data is still in its own volume, but
`npm run dev` and `npm test` will fail to connect until you switch back:

```bash
docker compose -f docker-compose.prod.yml down
docker compose up -d
```

The totem is then on <http://127.0.0.1:8080>, served by nginx, which also
proxies `/api` to the API container so the browser sees one origin.

This is not a production deployment — no TLS, no secret management, no backups —
but it is a real one: the API runs compiled JavaScript with production
dependencies only, as a non-root user, and receives SIGTERM directly so a
payment in flight finishes instead of being cut off.

**A totem's identity is not in the image.** Each device reads `/totem.json` at
startup, which provisioning writes per device:

```json
{ "storeId": "a0000000-…-000000000001", "totemId": "b0000000-…-000000000001" }
```

Cloning one disk image across a fleet would otherwise give every screen the same
id, and duplicate ids are indistinguishable from real ones. A device with no
valid file shows an out-of-service screen rather than guessing a store.

## Testing

```bash
npm test              # everything
npm run test:api      # 128 tests, needs Postgres running
npm run test:totem    # 33 tests, no database needed
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
# Stop `npm run dev` first: this needs port 5180, which it is holding.
# Then keep the API and gateway up, since this starts only the UI:
npm run dev:api & npm run dev:gateway &

VITE_STORE_ID=a0000000-0000-4000-8000-000000000002 \
VITE_TOTEM_ID=b0000000-0000-4000-8000-000000000011 \
npm run dev:totem
```

These two variables are a development shortcut and are ignored in a production
build, where the device reads its identity from `/totem.json` instead.

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
| [API.md](API.md) | Every endpoint, with `curl` commands to exercise each one |
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
will reset whatever demo data you were looking at. If you ran the container
stack above, it took the `db` container over — `docker compose -f
docker-compose.prod.yml down && docker compose up -d` puts it back.

## Not built yet

Honest list: no authentication or TLS (the architecture doc explains when that
stops being enough), no real card reader, no refund path, no restocking
(`stock.quantity` is updated by hand), no receipt QR, no admin surface for
opening a store or entering its products, and no backups or metrics. Tax is
configured at 0 for both demo stores.
