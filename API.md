# API reference

Every endpoint, with a `curl` you can paste. Start the stack first:

```bash
docker compose up -d && npm run migrate && npm run seed && npm run dev
```

Set these once and the rest of the page works as written:

```bash
export API=http://127.0.0.1:3210
export GW=http://127.0.0.1:3220
export STORE=a0000000-0000-4000-8000-000000000001   # LOCAL-0001, USD
export TOTEM=b0000000-0000-4000-8000-000000000001   # that store's T1
```

The totem talks to the API through its own dev proxy on `http://127.0.0.1:5180/api`,
which maps to `$API`. Either origin works for these calls; `$API` is used below so
the examples do not depend on the UI running.

Pipe anything through `| jq` if you have it — the responses are plain JSON.

---

## Conventions

**Everything a store owns is under `/v1/stores/:storeId`.** The store id is the
partition key: it is what a future gateway routes on to reach the right shard, so
no endpoint ever spans two stores.

**Errors carry a stable `code`.** The totem picks its wording from the code, never
by parsing the message. Whatever context the error carries comes back alongside it,
so the caller does not have to re-read anything to react:

```json
{
  "error": "product_out_of_stock",
  "message": "Salted chips is no longer available",
  "productId": "11111111-1111-4111-8111-000000000001",
  "productName": "Salted chips",
  "available": 22
}
```

| Code | Status | When |
|---|---|---|
| `bad_request` | 400 | Failed schema validation |
| `totem_not_found` | 400 | Totem is not registered to this store |
| `product_unavailable` | 400 | This store does not sell that product |
| `store_not_found` | 404 | No such store |
| `order_not_found` | 404 | No such order in this store |
| `product_out_of_stock` | 409 | Not enough units left to reserve |
| `order_not_pending` | 409 | Order already paid, cancelled or in flight |
| `payment_in_flight` | 409 | This totem has a payment running; stock stays held |
| `order_expired` | 410 | The reservation TTL passed |
| `database_busy` | 503 | Pool timeout or lost retry budget — safe to retry |

Request bodies are validated before any handler runs, and unknown fields are
dropped rather than passed through.

---

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Process and database liveness |
| `GET` | `/v1/stores/:storeId` | Store settings (currency, locale, tax) |
| `GET` | `/v1/stores/:storeId/menu` | Products with live availability |
| `GET` | `/v1/stores/:storeId/health/stock` | Stock invariant check |
| `GET` | `/v1/stores/:storeId/health/orders` | Payments needing a human |
| `POST` | `/v1/stores/:storeId/orders` | Create an order, reserve stock |
| `GET` | `/v1/stores/:storeId/orders/:orderId` | Read one order |
| `POST` | `/v1/stores/:storeId/orders/:orderId/payments` | Attempt payment |
| `POST` | `/v1/stores/:storeId/orders/:orderId/cancel` | Release the reservation |

### `GET /health`

Liveness for the process and its database. Not store-scoped — a load balancer
calls this without knowing about stores.

```bash
curl -s $API/health
```

```json
{ "status": "ok", "pool": { "total": 1, "idle": 1, "waiting": 0, "max": 20 } }
```

`waiting` above zero means requests are queueing for a connection. It is the
first thing to look at when the API is slow but the database is not.

### `GET /v1/stores/:storeId`

What a totem needs before it can render anything: which currency to format, which
language to speak, what tax to show.

```bash
curl -s $API/v1/stores/$STORE
```

```json
{
  "id": "a0000000-0000-4000-8000-000000000001",
  "code": "LOCAL-0001",
  "name": "Snack Bar",
  "countryCode": "US",
  "timezone": "UTC",
  "currency": "USD",
  "locale": "en-US",
  "taxBasisPoints": 0
}
```

Tax is in basis points (800 = 8%), so it stays an integer like every other money
value here.

Try the Brazilian store to see the same endpoint drive a different language and
currency:

```bash
curl -s $API/v1/stores/a0000000-0000-4000-8000-000000000002
```

### `GET /v1/stores/:storeId/menu`

The product grid. Read from the database on every request — there is no menu
cache, so availability is never stale.

```bash
curl -s $API/v1/stores/$STORE/menu
```

```json
{
  "storeId": "a0000000-…",
  "currency": "USD",
  "items": [
    {
      "id": "11111111-1111-4111-8111-000000000001",
      "name": "Salted chips",
      "description": "150 g bag",
      "priceCents": 240,
      "imageUrl": null,
      "availableQuantity": 24,
      "outOfStock": false
    }
  ]
}
```

`availableQuantity` is already net of what other customers are holding.

Grab an id for the calls below:

```bash
export CHIPS=$(curl -s $API/v1/stores/$STORE/menu \
  | grep -o '"id":"[^"]*","name":"Salted chips"' | cut -d'"' -f4)
echo $CHIPS
```

### `POST /v1/stores/:storeId/orders`

Creates the order **and reserves the stock**. This is the moment a customer stops
browsing and commits, and the reservation is what stops two totems selling the
same last unit.

```bash
curl -s -X POST $API/v1/stores/$STORE/orders \
  -H 'content-type: application/json' \
  -d "{\"totemId\":\"$TOTEM\",\"items\":[{\"productId\":\"$CHIPS\",\"quantity\":2}]}"
```

`201 Created`:

```json
{
  "id": "b1bb5a53-…",
  "storeId": "a0000000-…",
  "totemId": "b0000000-…",
  "status": "pending",
  "currency": "USD",
  "subtotalCents": 480,
  "taxCents": 0,
  "totalCents": 480,
  "expiresAt": "2026-09-17T12:15:00.000Z",
  "items": [{ "productId": "1111…", "name": "Salted chips", "quantity": 2, "unitPriceCents": 240 }]
}
```

Body rules: `items` holds 1–50 lines, each `quantity` 1–99, and every id must be a
UUID. Prices are snapshotted onto the line, so a later price change never rewrites
what this customer was charged.

Save the id:

```bash
export ORDER=$(curl -s -X POST $API/v1/stores/$STORE/orders \
  -H 'content-type: application/json' \
  -d "{\"totemId\":\"$TOTEM\",\"items\":[{\"productId\":\"$CHIPS\",\"quantity\":2}]}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo $ORDER
```

**One open order per totem.** Creating an order closes that totem's previous
unpaid one and returns its stock, so a customer who walks away does not hold
stock while the next person is told it is sold out. Run the command twice and
check `/health/stock` — the reservation does not accumulate.

Asking for more than is on the shelf gives `409 product_out_of_stock`:

```bash
curl -s -X POST $API/v1/stores/$STORE/orders \
  -H 'content-type: application/json' \
  -d "{\"totemId\":\"$TOTEM\",\"items\":[{\"productId\":\"$CHIPS\",\"quantity\":99}]}"
```

### `GET /v1/stores/:storeId/orders/:orderId`

```bash
curl -s $API/v1/stores/$STORE/orders/$ORDER
```

Same shape as the create response, with the current `status`. An order from
another store returns `404` even with a valid id — stores are isolated.

### `POST /v1/stores/:storeId/orders/:orderId/payments`

Attempts payment and resolves it inside the request.

```bash
curl -s -X POST $API/v1/stores/$STORE/orders/$ORDER/payments \
  -H 'content-type: application/json' -d '{"method":"card"}'
```

```json
{
  "storeId": "a0000000-…",
  "orderId": "b1bb5a53-…",
  "paymentId": "89a24c8b-…",
  "status": "succeeded",
  "orderStatus": "paid",
  "amountCents": 480
}
```

`method` is `card` (default), `wallet` or `qr`. The body is optional — `-d '{}'`
or no body at all both work.

**It answers `201` whatever the outcome.** The attempt is a real record that was
created; whether the money moved is in `status`, which is one of three values:

| `status` | `orderStatus` | Meaning |
|---|---|---|
| `succeeded` | `paid` | Charged, stock committed |
| `failed` | `failed` | Declined. Nothing charged, stock released |
| `unknown` | `confirmed` | **Not guessed at.** Stock stays held and the resolver keeps asking the gateway until it knows |

The third is the one worth understanding: a timeout does not mean the card was
not charged. See [PAYMENT_TESTING.md](PAYMENT_TESTING.md).

Paying twice is refused, not double-charged:

```bash
curl -s -X POST $API/v1/stores/$STORE/orders/$ORDER/payments \
  -H 'content-type: application/json' -d '{"method":"card"}'
# {"error":"order_not_pending","message":"Order is paid, not pending"}
```

### `POST /v1/stores/:storeId/orders/:orderId/cancel`

Releases the reservation and puts the stock back. Idempotent.

```bash
curl -s -X POST $API/v1/stores/$STORE/orders/$ORDER/cancel
# {"status":"cancelled"}
```

A verb in the path, deliberately. Orders are financial records and are never
deleted, so `DELETE` would misdescribe what happens; cancelling is an action on
the order, and the row survives it.

An order with a payment in flight is not cancellable — it answers
`409 payment_in_flight` and keeps holding its stock, because the card may well
have been charged.

### `GET /v1/stores/:storeId/health/stock`

Checks the invariant that `reserved` equals the stock held by this store's live
orders. A non-empty `drifted` list means stock accounting has gone wrong.

```bash
curl -s $API/v1/stores/$STORE/health/stock
# {"ok":true,"drifted":[]}
```

Store-scoped on purpose: a national version would be a full-table aggregate, and
after sharding it could not run in one query anyway.

### `GET /v1/stores/:storeId/health/orders`

The reconciliation queue — the endpoint a member of staff is really asking about.

```bash
curl -s $API/v1/stores/$STORE/health/orders
```

```json
{ "ok": true, "chargedButNotPaid": [], "needsReconciliation": [] }
```

- **`needsReconciliation`** — orders stuck in `confirmed`: a payment was in flight
  and never resolved. They hold stock, and the expiry reaper skips them on
  purpose. Only a human checking with the processor can close one out.
- **`chargedButNotPaid`** — the gateway accepted a charge for an order that did
  not end up paid. The customer was charged and got no goods, so someone has to
  refund. The resolver cannot fix these; it can only stop creating them.

Both lists empty is the normal state.

---

## A full purchase, end to end

Paste this whole block. It creates an order, shows the stock held, pays, and shows
the stock committed.

```bash
STOCK() { curl -s $API/v1/stores/$STORE/menu \
  | grep -o "\"name\":\"Salted chips\"[^}]*" | grep -o '"availableQuantity":[0-9]*'; }

echo "before:      $(STOCK)"

ORDER=$(curl -s -X POST $API/v1/stores/$STORE/orders \
  -H 'content-type: application/json' \
  -d "{\"totemId\":\"$TOTEM\",\"items\":[{\"productId\":\"$CHIPS\",\"quantity\":2}]}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "reserved:    $(STOCK)"
echo "payment:     $(curl -s -X POST $API/v1/stores/$STORE/orders/$ORDER/payments \
  -H 'content-type: application/json' -d '{"method":"card"}')"
echo "after:       $(STOCK)"
echo "invariant:   $(curl -s $API/v1/stores/$STORE/health/stock)"
```

Expected: availability drops by 2 at reservation, stays down after payment, and
the invariant stays `ok:true` throughout.

---

## Gateway endpoints (development only)

A stand-in for a card processor, on `$GW`. Not part of the product — it exists so
the failure paths are reachable on demand. Reach it through payments by starting
the stack with `npm run dev:gateway-payments`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness and the active scenario |
| `POST` | `/charges` | Charge, keyed by idempotency key |
| `GET` | `/charges/:key` | Poll one charge |
| `GET` | `/control/scenario` | Current scenario and the full list |
| `POST` | `/control/scenario` | Change how the gateway behaves |
| `POST` | `/control/reset` | Back to `approved`, charges cleared |
| `GET` | `/control/charges` | Everything it thinks it charged |

Most of the time `npm run scenario` is the friendlier way in; these are the same
controls underneath.

### Driving the gateway

```bash
curl -s $GW/health
curl -s $GW/control/scenario                     # current + every scenario, described

curl -s -X POST $GW/control/scenario \
  -H 'content-type: application/json' \
  -d '{"scenario":"declined_insufficient_funds"}'

curl -s -X POST $GW/control/scenario \
  -H 'content-type: application/json' \
  -d '{"scenario":"network_error","failures":2}'   # drops twice, then works

curl -s -X POST $GW/control/scenario \
  -H 'content-type: application/json' \
  -d '{"scenario":"timeout_then_approved","settleAfterMs":8000}'

curl -s $GW/control/charges
curl -s -X POST $GW/control/reset
```

Scenario fields: `failures` (how many attempts fail first), `delayMs` (for
`slow`), `settleAfterMs` and `respondAfterMs` (for the timeout scenarios). The
full list with descriptions comes back from `GET /control/scenario`, and the
behaviour of each is documented in [PAYMENT_TESTING.md](PAYMENT_TESTING.md).

### Charging it directly

Useful for seeing idempotency on its own, without an order in the way.

```bash
curl -s -X POST $GW/charges \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"demo_1","amountCents":480,"currency":"USD","method":"card"}'
# {"chargeId":"ch_demo_1","status":"approved","amountCents":480,"currency":"USD"}

# Same key again: replayed, not charged twice. Note the idempotent-replay header.
curl -si -X POST $GW/charges \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"demo_1","amountCents":480,"currency":"USD","method":"card"}' \
  | grep -i 'idempotent-replay'

# Same key, different amount: refused.
curl -s -X POST $GW/charges \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"demo_1","amountCents":999,"currency":"USD"}'
# {"error":"idempotency_key_reuse", …}

curl -s $GW/charges/demo_1
```

`scenario` can also be set per request, so a test never has to mutate global
state:

```bash
curl -s -X POST $GW/charges \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"demo_2","amountCents":100,"scenario":"declined_card_expired"}'
# {"chargeId":"ch_demo_2","status":"declined","amountCents":100,"currency":"USD",
#  "declineCode":"card_expired"}
```

That idempotency promise is what lets the checkout retry a payment safely, and it
is why an interrupted attempt can be finished later instead of charged again.
