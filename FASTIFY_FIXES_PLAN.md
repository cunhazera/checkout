# Plan: fix three API boundary bugs

Three bugs found by reviewing `packages/api` against the `fastify` skill. Each
was confirmed by sending real requests with `inject()`.

**Status: applied on 2026-09-14**, as part of the multi-store API rewrite (see
`DISTRIBUTED_ARCHITECTURE.md`). Route paths below are the pre-`/v1` ones; the
shipped code uses `/v1/stores/:storeId/...`, and its tests live in
`test/boundary.test.ts`.

Before being applied, every code block below was prototyped on a copy of
`packages/api` and verified there:

- Typecheck: 0 errors
- Full suite: **67/67 passing** (the current 55 + 12 new)
- The new tests were also run against the **current** code: 8 fail, one or more
  per bug, which proves they catch the bugs. The other 4 pass on both versions,
  on purpose: they guard behavior the fixes must not break.

| # | Bug | Current behavior | After |
|---|---|---|---|
| 1 | Error handler turns client errors into 500 | 2 MB body → `500 internal_error` | `413 payload_too_large` |
| 2 | No input schemas | `GET /orders/not-a-uuid` → Postgres `22P02` → `500` | `400 validation_error` before any handler runs |
| 3 | Custom JSON parser dropped poisoning protection | `{"__proto__": …}` body creates an order | `400 bad_request` |

## Order of work

1. **Bug 1 first.** Bug 2's schema failures and bug 3's parser errors both reach
   the error handler. Without bug 1's fix, both would come back as 500.
2. **Bug 2.** This is the largest change: one new file plus route options.
3. **Bug 3.** A few lines in `app.ts`.
4. Add `test/boundary.test.ts`, then run the typecheck and the suite.

Files touched: `src/app.ts`, `src/routes/orders.ts`, new `src/routes/schemas.ts`,
new `test/boundary.test.ts`.

---

## Bug 1: client errors reported as server errors

**Problem.** `setErrorHandler` in `src/app.ts` passes our own `AppError`s
through, but every other error becomes `500 internal_error` and is logged at
`error` level. That includes errors Fastify has already classified as client
errors: `FST_ERR_CTP_BODY_TOO_LARGE` (413) and unsupported content types (415).

**Evidence.** A 2 MB body gets `500 {"error":"internal_error"}`. The same
request against Fastify's default handler gets
`413 FST_ERR_CTP_BODY_TOO_LARGE`.

**Fix.** Keep the status of any error that already has a 4xx code, give it a
stable snake_case code consistent with `AppError`, and log it at `info`
instead of `error`. Schema validation failures get their own
`validation_error` code.

`src/app.ts`: add above `buildApp`:

```ts
/** Stable snake_case codes, matching the ones AppError already uses. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};
```

`src/app.ts`: update the import and replace the error handler:

```ts
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
```

```ts
// Fastify 5.12 types the handler's error as `unknown`; the generic restores
// `statusCode` and `validation`.
app.setErrorHandler<FastifyError>((err, req, reply) => {
  if (err instanceof AppError) {
    // The totem keys its copy off `code`, per the design's edge-case table.
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ?? {}),
    });
  }

  // Schema validation failed before any handler ran.
  if (err.validation) {
    return reply.code(400).send({
      error: 'validation_error',
      message: err.message,
    });
  }

  // Errors Fastify has already classified as the client's fault (body too
  // large, invalid JSON, unsupported media type) keep their status. Only
  // genuine server failures become 500.
  const status = err.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    req.log.info({ err }, 'client error');
    return reply.code(status).send({
      error: CLIENT_ERROR_CODES[status] ?? 'client_error',
      message: err.message,
    });
  }

  req.log.error(err);
  return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
});
```

---

## Bug 2: malformed input reaches Postgres

**Problem.** No route declares a schema, so any string reaches the services. A
malformed UUID fails inside Postgres and returns a 500. This affects every route
with `:orderId`, and `itemId` in order bodies.

**Evidence** (all `500 internal_error` today):

| Request | Underlying error |
|---|---|
| `GET /orders/not-a-uuid` | Postgres `22P02` invalid input syntax for type uuid |
| `POST /orders` with `itemId: "abc"` | same |
| `POST /orders` with a 300-character `sessionId` | column is `VARCHAR(255)`; the INSERT fails |

**Fix.** Declare JSON schemas so Fastify rejects bad input with a 400 before the
handler runs. This is the skill's "schema-first" principle.

### Decisions baked into the schemas

These were checked against how Fastify 5.12 actually behaves, not assumed:

- **Type coercion is turned off.** Fastify's default `coerceTypes: 'array'`
  would quietly turn `quantity: "2"` into `2`, which we currently reject.
  Every route param here is a string, so turning coercion off costs nothing.
- **`additionalProperties: false` on every object.** Fastify only strips
  unknown fields when a schema says this. With it, a client-supplied
  `totalCents` or `priceCents` is dropped, not passed to the services.
- **`sessionId` capped at 255 characters**, matching the column.
- **`POST /pay` still works with no body.** A body schema rejects a missing
  body outright (`body must be object`), which would break the current default
  of `card`. A `preValidation` hook sets a missing body to `{}` first.
- **Service-level validation stays.** `validateLines` also rejects duplicate
  `itemId`s, which JSON Schema can't express, and the tests call services
  directly.

`src/app.ts`: add to the `Fastify({ ... })` options:

```ts
ajv: {
  // Fastify coerces types by default, which would quietly accept
  // `quantity: "2"` as 2. Every param here is a string anyway, so strict
  // types cost nothing and keep the contract exact.
  customOptions: { coerceTypes: false },
},
```

New file `src/routes/schemas.ts`:

```ts
/**
 * Request schemas. Fastify validates these before any handler runs, so
 * malformed input is a 400 at the edge instead of an error from Postgres.
 *
 * Every object sets `additionalProperties: false`: with Fastify's default
 * `removeAdditional: true` that silently drops unknown fields rather than
 * passing them through to the services.
 */

const uuid = { type: 'string', format: 'uuid' } as const;

export const orderIdParams = {
  type: 'object',
  required: ['orderId'],
  additionalProperties: false,
  properties: { orderId: uuid },
} as const;

export const createOrderBody = {
  type: 'object',
  required: ['sessionId', 'items'],
  additionalProperties: false,
  properties: {
    // orders.session_id is VARCHAR(255); longer values failed in the INSERT.
    sessionId: { type: 'string', minLength: 1, maxLength: 255 },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['itemId', 'quantity'],
        additionalProperties: false,
        properties: {
          itemId: uuid,
          quantity: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

export const payBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', enum: ['card', 'wallet', 'qr'] },
  },
} as const;
```

`src/routes/orders.ts`: import the schemas and attach them to each route:

```ts
import { createOrderBody, orderIdParams, payBody } from './schemas.js';
```

```ts
export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateOrderBody }>(
    '/orders',
    { schema: { body: createOrderBody } },
    async (req, reply) => {
      // The schema guarantees a body, so the old `?? {}` fallback is gone.
      const { sessionId, items } = req.body;
      const order = await createOrder(sessionId, items);
      reply.code(201);
      return order;
    },
  );

  app.get<{ Params: { orderId: string } }>(
    '/orders/:orderId',
    { schema: { params: orderIdParams } },
    async (req) => getOrder(req.params.orderId),
  );

  app.post<{ Params: { orderId: string }; Body: PayBody }>(
    '/orders/:orderId/pay',
    {
      schema: { params: orderIdParams, body: payBody },
      // The body is optional here (method defaults to card), but a body schema
      // rejects a missing body outright. Default it before validation runs.
      preValidation: async (req) => {
        req.body ??= {};
      },
      // Unchanged; out of scope for this plan (see below).
      config: { payloadTimeoutMs: config.paymentPollTimeoutMs + 15_000 },
    },
    async (req) => payOrder(req.params.orderId, req.body?.method ?? 'card'),
  );

  app.delete<{ Params: { orderId: string } }>(
    '/orders/:orderId/abandon',
    { schema: { params: orderIdParams } },
    async (req) => abandonOrder(req.params.orderId),
  );
}
```

---

## Bug 3: JSON parser lost prototype-poisoning protection

**Problem.** To let bodyless requests that declare `application/json` through,
`src/app.ts` replaced Fastify's JSON parser with one built on plain
`JSON.parse`. Fastify's default parser rejects `__proto__` and
`constructor.prototype` keys; `JSON.parse` doesn't.

**Evidence.** An otherwise valid order body with a `__proto__` key is accepted
today and creates an order (201). Fastify's default parser rejects the same body
with `400 FST_ERR_CTP_INVALID_JSON_BODY`.

**Impact.** Not exploitable in the current code, because nothing merges request
bodies into other objects. It is still a Fastify safety default that shouldn't
have been removed.

**Fix.** Keep the empty-body special case and hand everything else to Fastify's
own parser, via the public `app.getDefaultJsonParser()`.

`src/app.ts`: replace the `addContentTypeParser` block:

```ts
/**
 * Treat an empty body as {} instead of rejecting it. POST /session/start and
 * DELETE /orders/:id/abandon legitimately carry no body, and a client that
 * sets content-type: application/json on every request — as fetch wrappers
 * commonly do — would otherwise get FST_ERR_CTP_EMPTY_JSON_BODY.
 *
 * Everything else goes to Fastify's own parser, which rejects __proto__ and
 * constructor.prototype keys. Plain JSON.parse would accept them.
 */
const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  // parseAs: 'string' guarantees a string here.
  const raw = body as string;
  if (raw.trim() === '') return done(null, {});
  defaultJsonParser(req, raw, done);
});
```

Invalid JSON keeps returning `400 bad_request`: Fastify raises it with status
400, and bug 1's handler maps that to `bad_request`. The existing test
`rejects a malformed JSON body with a clean error code` still passes.

---

## Tests: new file `test/boundary.test.ts`

Results against the current code:

| Test | Current code | Fixed code |
|---|---|---|
| 413 for an oversized body | fails | passes |
| 415 for an unsupported content type | fails | passes |
| 400 for a non-UUID order id (GET, POST pay, DELETE) | fails | passes |
| 400 for a non-UUID itemId, nothing reserved | fails | passes |
| 400 for a sessionId longer than the column | fails | passes |
| 400 for an unknown payment method | fails | passes |
| rejects `__proto__` poisoning | fails | passes |
| rejects `constructor.prototype` poisoning | fails | passes |
| does not coerce a string quantity | passes | passes (guards the coercion change) |
| still pays when the request has no body | passes | passes (guards the `preValidation` hook) |
| drops unknown fields | passes | passes (guards `additionalProperties: false`) |
| still accepts a bodyless request declaring JSON | passes | passes (guards bug 3's special case) |

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { ITEM, getStock, resetDatabase, setupDatabase } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await setupDatabase();
  app = await buildApp();
});
beforeEach(resetDatabase);
afterAll(async () => {
  await app.close();
  await closePool();
});

const order = (body: unknown) =>
  app.inject({ method: 'POST', url: '/orders', payload: body as object });

// Bug 1: Fastify's own 4xx errors must not be reported as server failures.
describe('client errors keep their status', () => {
  it('returns 413 for an oversized body, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ sessionId: 's', pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('returns 415 for an unsupported content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'content-type': 'application/xml' },
      payload: '<order/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported_media_type');
  });
});

// Bug 2: malformed input is rejected by schema before it reaches Postgres.
describe('request schemas', () => {
  it('rejects a non-UUID order id with 400', async () => {
    for (const [method, url] of [
      ['GET', '/orders/not-a-uuid'],
      ['POST', '/orders/not-a-uuid/pay'],
      ['DELETE', '/orders/not-a-uuid/abandon'],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().error).toBe('validation_error');
    }
  });

  it('rejects a non-UUID itemId without reserving anything', async () => {
    const res = await order({ sessionId: 's', items: [{ itemId: 'abc', quantity: 1 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects a sessionId longer than the column', async () => {
    const res = await order({
      sessionId: 'x'.repeat(256),
      items: [{ itemId: ITEM.chips, quantity: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('does not coerce a string quantity', async () => {
    const res = await order({ sessionId: 's', items: [{ itemId: ITEM.chips, quantity: '2' }] });
    expect(res.statusCode).toBe(400);
  });

  it('still pays when the request has no body at all', async () => {
    const created = (await order({ sessionId: 's', items: [{ itemId: ITEM.chips, quantity: 1 }] })).json();
    const res = await app.inject({ method: 'POST', url: `/orders/${created.id}/pay` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('succeeded');
  });

  it('rejects an unknown payment method', async () => {
    const created = (await order({ sessionId: 's', items: [{ itemId: ITEM.chips, quantity: 1 }] })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/orders/${created.id}/pay`,
      payload: { method: 'cash' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('drops unknown fields instead of passing them on', async () => {
    const res = await order({
      sessionId: 's',
      items: [{ itemId: ITEM.chips, quantity: 1, priceCents: 1 }],
      totalCents: 1,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(240); // server price, not the injected one
  });
});

// Bug 3: the empty-body special case must not weaken JSON parsing.
describe('JSON body parsing', () => {
  it('rejects prototype poisoning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'content-type': 'application/json' },
      // An otherwise valid order, so only the parser can be what rejects it.
      payload: `{"__proto__":{"polluted":true},"sessionId":"s","items":[{"itemId":"${ITEM.chips}","quantity":1}]}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('rejects constructor.prototype poisoning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: `{"constructor":{"prototype":{"polluted":true}},"sessionId":"s","items":[{"itemId":"${ITEM.chips}","quantity":1}]}`,
    });
    expect(res.statusCode).toBe(400);
    expect((await getStock(ITEM.chips)).reserved).toBe(0);
  });

  it('still accepts a bodyless request that declares JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/session/start',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
  });
});
```

---

## Verification

```bash
npm run typecheck --workspace @checkout/api   # expect no errors
npm test --workspace @checkout/api            # expect 67 passed
```

## Effect on the totem

- **Normal use is unaffected.** The totem only sends well-formed UUIDs, integer
  quantities and one of the three payment methods. It branches on
  `item_out_of_stock` and `order_expired`, and neither changes.
- **New error codes a client can receive:** `validation_error`,
  `payload_too_large`, `unsupported_media_type`, `not_found`,
  `method_not_allowed`, `client_error`. The totem shows the `message` for any
  code it doesn't recognize. `validation_error` messages are technical (for
  example `body/items/0/itemId must match format "uuid"`), but the totem can't
  trigger them with its own inputs.

## Out of scope

Both came from the same review and are deliberately left out:

- **The `config.payloadTimeoutMs` setting on the pay route does nothing.** Route
  `config` is a free-form object Fastify never reads. The route runs without a
  time limit because of the server-wide `requestTimeout: 0` in `app.ts`. Remove
  the line and its comment.
- **404s use a different error format:** `{"message", "error": "Not Found",
  "statusCode"}` instead of `{"error": "<code>", "message"}`. Fix with
  `app.setNotFoundHandler`.
