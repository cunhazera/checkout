/**
 * What the mock gateway does when it is asked for a charge.
 *
 * Each scenario exists because a real payment provider does this to you at some
 * point, and the checkout has to survive it. Keeping them named and listed here
 * means both the automated tests and a person poking at a running totem drive
 * exactly the same behaviour.
 */
export const SCENARIOS = {
  approved: 'Charge succeeds immediately.',
  slow: 'Succeeds, but only after `delayMs` (default 3s) — still inside the client timeout.',

  declined_insufficient_funds: 'Declined: not enough money in the account.',
  declined_limit_exceeded: 'Declined: over the card limit.',
  declined_card_expired: 'Declined: expired card.',
  declined_do_not_honour: 'Declined with no reason given, which is what issuers usually send.',

  timeout_then_approved:
    'Never answers in time, but the charge DOES settle as approved. The customer was charged; ' +
    'the checkout has to discover that rather than assume failure.',
  timeout_then_declined: 'Never answers in time, and the charge settles as declined.',
  timeout_never_settles:
    'Never answers and never settles. The order must stay held for a human, never guessed at.',

  network_error:
    'Drops the connection mid-request `failures` times (default: always). Exercises retry, retry, fail.',
  server_error: 'HTTP 500 `failures` times, then succeeds. 5xx is retryable.',
  rate_limited: 'HTTP 429 with Retry-After `failures` times, then succeeds.',

  malformed_response: 'Answers 200 with a body that is not the agreed shape.',
  currency_mismatch: 'Rejects the charge because the currency is not one the gateway accepts.',
} as const;

export type ScenarioName = keyof typeof SCENARIOS;

export interface ScenarioConfig {
  scenario: ScenarioName;
  /** How many attempts fail before the scenario gives up failing. */
  failures?: number;
  /** For `slow`. */
  delayMs?: number;
  /** For the timeout scenarios: when the charge settles at the gateway. */
  settleAfterMs?: number;
  /** For the timeout scenarios: when the HTTP response finally arrives. */
  respondAfterMs?: number;
}

export const DEFAULT_SCENARIO: ScenarioConfig = { scenario: 'approved' };

export const isScenario = (v: unknown): v is ScenarioName =>
  typeof v === 'string' && v in SCENARIOS;
