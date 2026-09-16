# Testing the payment flow

`packages/gateway` is a mock card processor: a small HTTP service that answers
charge requests approved, declined, slowly, badly, or not at all, on demand. The
API talks to it over real HTTP through the `http` payment driver
(`packages/api/src/ports/http-terminal.ts`).

It exists so the checkout's failure handling can be *driven* instead of
imagined. It is not a payment implementation and holds no card data.

```
totem ──HTTP──> API ──HTTP──> mock gateway
                 │                  (in production: Stripe / SumUp / Adyen)
                 └── Postgres
```

## The three outcomes everything reduces to

The driver's whole job is turning every possible HTTP misadventure into one of
three answers, because ADR-003 is strict that the third must never be rounded
into the other two.

| Answer | Meaning | What the checkout does |
|---|---|---|
| **succeeded** | The gateway said approved | Order paid, stock decremented |
| **failed** | Definitely not charged | Order failed, stock released, customer may retry |
| **unknown** | It may or may not have been charged | Order held in `confirmed`, stock held, support reference shown, listed by `/health/orders` for a human |

The rule that decides between `failed` and `unknown` is: **did the request
provably never reach the gateway?** A refused connection means no charge exists,
so it is a clean failure. A timeout, a reset connection, a 500, or a response we
cannot parse all mean it might have been charged, so it is unknown.

## Scenarios

| Scenario | What the gateway does | Expected result |
|---|---|---|
| `approved` | Approves immediately | succeeded |
| `slow` | Approves after `--delay` ms (default 3000) | succeeded |
| `declined_insufficient_funds` | Declines: not enough money | failed, `insufficient_funds` |
| `declined_limit_exceeded` | Declines: over the card limit | failed, `limit_exceeded` |
| `declined_card_expired` | Declines: expired card | failed, `card_expired` |
| `declined_do_not_honour` | Declines with no reason, as issuers often do | failed, `do_not_honour` |
| `timeout_then_approved` | Answers far too late, but the charge **does** settle approved | unknown at first, then **succeeded** once reconciliation finds it |
| `timeout_then_declined` | Answers too late, charge settles declined | failed after reconciliation |
| `timeout_never_settles` | Never answers, never settles | **unknown**, held for a human |
| `network_error` | Severs the TCP connection `--failures` times (default: always) | succeeded if a retry gets through, otherwise unknown |
| `server_error` | HTTP 500 `--failures` times, then approves | succeeded after retries |
| `rate_limited` | HTTP 429 with `Retry-After`, `--failures` times | succeeded after retries |
| `malformed_response` | Charges the card, then answers with a body we cannot read | succeeded — reconciliation goes back and asks |
| `currency_mismatch` | Rejects the request outright (422) | failed, `currency_not_supported`, nothing charged |

## Automated tests

```bash
npm test --workspace @checkout/api            # all 114
npx vitest run test/gateway.test.ts --root packages/api          # 21 gateway scenarios
npx vitest run test/payment-resolver.test.ts --root packages/api # 11 crash-recovery cases
```

The tests start the gateway in-process on a random port and point a real
`HttpTerminal` at it, so the HTTP call, the timeout, the retries and the socket
errors are all genuine. Each one drives a full `payOrder` against the real
database and then asserts the order status, the stock, and the payment row.

They use a 1-second client timeout so the slow cases finish quickly, and
`vitest.config.ts` shortens the reconciliation window from 30 s to 3 s. Those
change how long the tests take, not which outcome they reach.

What they pin down, beyond the table above:

- **A decline never moves physical stock**, and always gives the reservation back.
- **A timeout that was really approved ends as paid.** The most expensive bug
  available here is assuming failure and handing over goods that were paid for.
- **An unresolved payment is never guessed at.** The order stays `confirmed`,
  the stock stays held, and it shows up in `/health/orders`.
- **A dropped connection is retried**, and a charge is created only once.
- **An unreachable gateway is a clean failure**, so the customer can just try again.
- **The same idempotency key charges once**, and reusing it with a different
  amount is refused.
- **A double-tap on Pay reaches the gateway once.**
- **The store's currency is sent**, so a BRL store charges in BRL.

## Testing it live

```bash
docker compose up -d
npm run dev:gateway-payments
```

That starts the gateway (`:3220`), the API pointed at it over HTTP (`:3210`),
and the totem (`:5180`). Open <http://127.0.0.1:5180>, then change the gateway's
behaviour between purchases:

```bash
npm run scenario                                  # list, and show what is active
npm run scenario approved
npm run scenario declined_insufficient_funds
npm run scenario -- network_error --failures 2    # drop twice, then work
npm run scenario -- timeout_then_approved --settle 8000
npm run scenario -- --charges                     # what the gateway thinks it charged
npm run scenario -- --reset
```

**Note the `--`.** Without it, `npm run` swallows flags like `--failures` and
you silently get the default (fail forever) instead.

### What you should see on the totem

| Scenario | On screen |
|---|---|
| `approved` | "Paid. Enjoy." with the receipt QR, returns to the welcome screen after 12 s |
| any `declined_*` | "Payment declined", with "Try payment again" — the basket survives |
| `timeout_then_approved --settle 8000` | "Confirming your payment…" for about 15 s, then success |
| `timeout_never_settles` | "Confirming your payment…", then "Please contact staff" with the order reference |
| `network_error` | Same as above: the checkout refuses to guess |

### Watching what actually happened

```bash
# orders waiting on a human, per store
curl -s http://127.0.0.1:3210/v1/stores/a0000000-0000-4000-8000-000000000001/health/orders | python3 -m json.tool

# stock accounting still adds up
curl -s http://127.0.0.1:3210/v1/stores/a0000000-0000-4000-8000-000000000001/health/stock | python3 -m json.tool

# the gateway's side of the story
npm run scenario -- --charges
```

A verified live run, one purchase per scenario:

| Scenario | Result | Order | Took |
|---|---|---|---|
| `approved` | succeeded | paid | <1 s |
| `declined_insufficient_funds` | failed | failed | <1 s |
| `declined_limit_exceeded` | failed | failed | <1 s |
| `network_error --failures 2` | succeeded | paid | 1 s |
| `network_error` (always) | unknown | confirmed | 30 s |
| `timeout_then_approved --settle 8000` | succeeded | paid | 17 s |
| `timeout_never_settles` | unknown | confirmed | 46 s |

The 30 s and 46 s are the real reconciliation window plus the 15 s client
timeout, exactly as configured for production.

## Recovering payments a crash interrupted

`payOrder` records its intent — the order claimed as `confirmed`, plus a payment
row holding the idempotency key — in **one transaction before** calling the
gateway. That ordering means a crash can never lose the fact that a charge might
exist. It is half of the outbox pattern.

The other half is `jobs/payment-resolver.ts`. Without it, a process killed
mid-charge left the order `confirmed`, the stock reserved and the customer
possibly charged, forever: the expiry reaper refuses to touch `confirmed` orders
(releasing a paid order's stock would oversell it), so nothing finished the job.

Every 30 s the resolver takes payments still in `pending` or `unknown`, older
than a grace period, and asks the gateway what happened using the stored key:

| Gateway says | Resolver does |
|---|---|
| approved | Settles the order paid and decrements stock |
| declined | Fails the order and releases the stock |
| **no record of that key** | Releases the stock: a gateway records a charge when it accepts one, so no record after the grace period means no money moved |
| still pending | Leaves it, counts the attempt |
| after `MAX_ATTEMPTS` | Stops asking, logs loudly, waits for a person |

Design points that matter:

- **Settling is idempotent.** Stock only moves on the real transition out of
  `confirmed` (`UPDATE … WHERE status = 'confirmed'`, act only if it changed a
  row). Without that guard, a resolver and a live request settling the same
  attempt would each decrement the shelf — selling one unit twice. There is a
  test for it, and the database's `CHECK (reserved >= 0)` catches it too.
- **`FOR UPDATE SKIP LOCKED`**, so several API instances can run the sweep
  without two of them resolving the same attempt.
- **A grace period**, so the resolver never races a request that still owns the
  attempt.
- **The gateway call happens outside the transaction**, as everywhere else.
- **Records are never deleted.** Once a request may have reached the gateway,
  our row is the only evidence money moved.

### Seeing it work

```bash
npm run scenario -- timeout_then_approved --settle 300 --respond 20000
# start a payment, then kill -9 the API while the gateway is still thinking
```

A verified run: the gateway held an approved 480-cent charge while the database
said `order=confirmed payment=pending reserved=2`. Six seconds after the API was
restarted:

```
payment 15f861f6 (order aa7f787e) resolved as succeeded; order is now paid
payment resolver: checked 1, settled 1, still unknown 0, exhausted 0
```

Stock went 24 → 22 exactly once, and `/health/orders` returned to `ok: true`.

### What it still cannot fix

If a charge succeeds for an order that was already released as failed, the stock
is gone and may have been sold to someone else. No automated step can undo that;
it needs a refund. `/health/orders` reports these separately as
`chargedButNotPaid` so they are at least visible.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAYMENT_DRIVER` | `fake` | `fake` (in-process) or `http` (the gateway) |
| `PAYMENT_GATEWAY_URL` | `http://127.0.0.1:3220` | where the `http` driver sends charges |
| `PAYMENT_HTTP_TIMEOUT_MS` | `15000` | per attempt; past this the outcome is unknown |
| `PAYMENT_HTTP_RETRIES` | `2` | retries after the first attempt, for network errors, 5xx and 429 |
| `PAYMENT_POLL_INTERVAL_MS` | `2000` | reconciliation poll gap |
| `PAYMENT_POLL_TIMEOUT_MS` | `30000` | how long reconciliation keeps asking |
| `PAYMENT_RESOLVE_INTERVAL_MS` | `30000` | how often the resolver sweeps |
| `PAYMENT_RESOLVE_GRACE_MS` | `60000` | how long an attempt is left to the live request |
| `PAYMENT_RESOLVE_MAX_ATTEMPTS` | `10` | tries before it waits for a human |
| `GATEWAY_PORT` | `3220` | mock gateway port |

The `fake` driver stays the default, so the other test files and a plain
`npm run dev` do not need the gateway running.

## Worth knowing

- **A timeout is never retried.** With an idempotency key it would be safe, but
  reconciliation is the better tool: it polls until the gateway commits to an
  answer, rather than piling on more requests while one may still be running.
- **Retries could outlive shutdown.** The client timeout (15 s) plus the
  reconciliation window (30 s) is 45 s, which is exactly the shutdown grace
  period in `server.ts`. Raising either means raising that too.
- **Stock stays held on unknown, forever, on purpose.** The expiry job skips
  `confirmed` orders. Releasing them could oversell something a customer paid
  for. `/health/orders` is how they get found.

## Not covered

Things a real integration needs that this mock does not pretend to do:

- **Refunds and voids.** When the resolver finds a charge for an order that was
  already released, someone must give the money back. There is no refund path.
- **3-D Secure / SCA**, where the customer authenticates mid-payment.
- **Asynchronous settlement**, where the processor calls back later by webhook
  rather than answering the request.
- **Partial captures, tips, chargebacks.**
- **Card data.** No PAN ever reaches this system, and none should. A real
  terminal keeps the checkout out of PCI scope, and that property is worth
  protecting.
