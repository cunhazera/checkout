import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEFAULT_SCENARIO,
  isScenario,
  SCENARIOS,
  type ScenarioConfig,
  type ScenarioName,
} from './scenarios.js';

type ChargeStatus = 'pending' | 'approved' | 'declined';

interface Charge {
  id: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  method: string;
  status: ChargeStatus;
  declineCode?: string;
  /** Before this moment the charge reads as pending, after it as `settled`. */
  settleAt: number;
  settled: Exclude<ChargeStatus, 'pending'>;
  createdAt: string;
}

interface ChargeBody {
  amountCents?: number;
  currency?: string;
  method?: string;
  idempotencyKey?: string;
  /** Per-request override, so an automated test never has to mutate global state. */
  scenario?: ScenarioName;
}

const DECLINE_CODES: Partial<Record<ScenarioName, string>> = {
  declined_insufficient_funds: 'insufficient_funds',
  declined_limit_exceeded: 'limit_exceeded',
  declined_card_expired: 'card_expired',
  declined_do_not_honour: 'do_not_honour',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for a card processor. Deliberately not a payment implementation:
 * it exists so the checkout's failure handling can be driven on demand.
 *
 * State is in memory and resets when the process restarts.
 */
export function buildGateway(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  const charges = new Map<string, Charge>();
  /** Attempts per idempotency key, so "fail twice then work" is expressible. */
  const attempts = new Map<string, number>();
  let active: ScenarioConfig = { ...DEFAULT_SCENARIO };

  const resolve = (c: Charge) => ({
    ...c,
    status: Date.now() >= c.settleAt ? c.settled : ('pending' as const),
  });

  const view = (c: Charge) => {
    const { status } = resolve(c);
    return {
      chargeId: c.id,
      status,
      amountCents: c.amountCents,
      currency: c.currency,
      ...(status === 'declined' && c.declineCode ? { declineCode: c.declineCode } : {}),
    };
  };

  app.get('/health', async () => ({ status: 'ok', scenario: active.scenario }));

  // --- control plane: how a human or a test chooses the behaviour ----------

  app.get('/control/scenario', async () => ({
    active,
    available: Object.entries(SCENARIOS).map(([name, description]) => ({ name, description })),
  }));

  app.post<{ Body: ScenarioConfig }>('/control/scenario', async (req, reply) => {
    const body = req.body ?? ({} as ScenarioConfig);
    if (!isScenario(body.scenario)) {
      return reply.code(400).send({
        error: 'unknown_scenario',
        message: `Unknown scenario: ${String(body.scenario)}`,
        available: Object.keys(SCENARIOS),
      });
    }
    active = { ...body, scenario: body.scenario };
    attempts.clear();
    req.log.info({ active }, 'scenario changed');
    return { active };
  });

  app.post('/control/reset', async () => {
    charges.clear();
    attempts.clear();
    active = { ...DEFAULT_SCENARIO };
    return { active, charges: 0 };
  });

  /** Everything the gateway believes it has charged. Useful for reconciling. */
  app.get('/control/charges', async () => ({
    charges: [...charges.values()].map(view),
  }));

  // --- the charge API the checkout actually calls --------------------------

  app.post<{ Body: ChargeBody }>('/charges', async (req, reply) => {
    const body = req.body ?? {};
    const { idempotencyKey, amountCents, currency = 'USD', method = 'card' } = body;

    if (!idempotencyKey || typeof amountCents !== 'number') {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'idempotencyKey and amountCents are required' });
    }

    // Replaying the same key must never charge twice. A real gateway's most
    // important promise, and the reason the checkout can retry safely.
    const existing = charges.get(idempotencyKey);
    if (existing) {
      if (existing.amountCents !== amountCents) {
        return reply.code(409).send({
          error: 'idempotency_key_reuse',
          message: 'This idempotency key was used with a different amount',
        });
      }
      reply.header('idempotent-replay', 'true');
      return view(existing);
    }

    const cfg: ScenarioConfig = body.scenario ? { ...active, scenario: body.scenario } : active;
    const attempt = (attempts.get(idempotencyKey) ?? 0) + 1;
    attempts.set(idempotencyKey, attempt);
    const stillFailing = attempt <= (cfg.failures ?? Number.POSITIVE_INFINITY);

    const record = (settled: 'approved' | 'declined', settleAfterMs = 0): Charge => {
      const charge: Charge = {
        id: `ch_${idempotencyKey}`,
        idempotencyKey,
        amountCents,
        currency,
        method,
        status: settleAfterMs > 0 ? 'pending' : settled,
        settled,
        settleAt: Date.now() + settleAfterMs,
        createdAt: new Date().toISOString(),
        ...(settled === 'declined' ? { declineCode: DECLINE_CODES[cfg.scenario] } : {}),
      };
      charges.set(idempotencyKey, charge);
      return charge;
    };

    switch (cfg.scenario) {
      case 'approved':
        return view(record('approved'));

      case 'slow':
        await sleep(cfg.delayMs ?? 3_000);
        return view(record('approved'));

      case 'declined_insufficient_funds':
      case 'declined_limit_exceeded':
      case 'declined_card_expired':
      case 'declined_do_not_honour':
        return view(record('declined'));

      case 'currency_mismatch':
        return reply.code(422).send({
          error: 'currency_not_supported',
          message: `This gateway does not accept ${currency}`,
        });

      case 'malformed_response':
        record('approved');
        // A 200 that is not the agreed shape: the client must not read this as
        // a successful charge just because the status code was 2xx.
        return reply.code(200).send({ nonsense: true });

      case 'network_error':
        if (stillFailing) {
          // Sever the TCP connection with no response. It has to be the socket:
          // destroying the request object alone leaves the client waiting for a
          // reply that never comes, which is a timeout, not a network error —
          // and the checkout treats those two very differently.
          reply.hijack();
          req.raw.socket.destroy();
          return;
        }
        return view(record('approved'));

      case 'server_error':
        if (stillFailing) {
          return reply.code(500).send({ error: 'internal_error', message: 'Gateway blew up' });
        }
        return view(record('approved'));

      case 'rate_limited':
        if (stillFailing) {
          return reply
            .code(429)
            .header('retry-after', '1')
            .send({ error: 'rate_limited', message: 'Slow down' });
        }
        return view(record('approved'));

      case 'timeout_then_approved':
      case 'timeout_then_declined':
      case 'timeout_never_settles': {
        const settles = cfg.scenario !== 'timeout_never_settles';
        const settleAfterMs = settles ? (cfg.settleAfterMs ?? 8_000) : 10 * 60_000;
        const charge = record(cfg.scenario === 'timeout_then_declined' ? 'declined' : 'approved', settleAfterMs);
        // Answer far too late. The client has long since given up, which is
        // exactly the situation ADR-003 calls 'unknown'.
        await sleep(cfg.respondAfterMs ?? 60_000);
        return view(charge);
      }
    }
  });

  /** Polled by the checkout while it does not know how a charge ended. */
  app.get<{ Params: { key: string } }>('/charges/:key', async (req, reply) => {
    const charge = charges.get(req.params.key);
    if (!charge) return reply.code(404).send({ error: 'charge_not_found' });
    return view(charge);
  });

  return app;
}
