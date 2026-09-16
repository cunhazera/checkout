#!/usr/bin/env node
/**
 * Switch what the mock payment gateway does, while everything is running.
 *
 *   npm run scenario                       list scenarios and show the active one
 *   npm run scenario approved
 *   npm run scenario declined_insufficient_funds
 *   npm run scenario network_error --failures 2
 *   npm run scenario timeout_then_approved --settle 8000 --respond 60000
 *   npm run scenario -- --charges          what the gateway thinks it charged
 *   npm run scenario -- --reset            clear charges, back to 'approved'
 */
const base = process.env.PAYMENT_GATEWAY_URL ?? 'http://127.0.0.1:3220';
const argv = process.argv.slice(2);

const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Number(argv[i + 1]);
};

const call = async (path, init) => {
  try {
    const res = await fetch(`${base}${path}`, init);
    return { ok: res.ok, body: await res.json() };
  } catch {
    console.error(`Cannot reach the gateway at ${base}. Is it running? (npm run dev)`);
    process.exit(1);
  }
};

const name = argv.find((a) => !a.startsWith('--') && Number.isNaN(Number(a)));

if (argv.includes('--reset')) {
  const { body } = await call('/control/reset', { method: 'POST' });
  console.log(`reset — active scenario: ${body.active.scenario}`);
} else if (argv.includes('--charges')) {
  const { body } = await call('/control/charges');
  if (body.charges.length === 0) console.log('no charges recorded');
  for (const c of body.charges) {
    console.log(`${c.chargeId}  ${c.status.padEnd(8)} ${c.amountCents} ${c.currency}${c.declineCode ? '  ' + c.declineCode : ''}`);
  }
} else if (!name) {
  const { body } = await call('/control/scenario');
  console.log(`active: ${JSON.stringify(body.active)}\n`);
  for (const s of body.available) console.log(`  ${s.name.padEnd(28)} ${s.description}`);
} else {
  const payload = { scenario: name };
  for (const [flagName, key] of [['failures', 'failures'], ['delay', 'delayMs'], ['settle', 'settleAfterMs'], ['respond', 'respondAfterMs']]) {
    const v = flag(flagName);
    if (v !== undefined) payload[key] = v;
  }
  const { ok, body } = await call('/control/scenario', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok) {
    console.error(`${body.message}\nAvailable: ${body.available.join(', ')}`);
    process.exit(1);
  }
  console.log(`active: ${JSON.stringify(body.active)}`);
}
