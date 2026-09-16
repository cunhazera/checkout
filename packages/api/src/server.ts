import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { startSessionCleanup } from './jobs/session-cleanup.js';
import { startPaymentResolver } from './jobs/payment-resolver.js';
import { setTerminal } from './services/payment.service.js';
import { HttpTerminal } from './ports/http-terminal.js';

/**
 * How long shutdown may take before the process is killed. Longer than the
 * usual 10s on purpose: POST /orders/:id/pay resolves inside the request and
 * can legitimately take the whole unknown-state polling window. Killing it
 * sooner would strand that order in 'confirmed' with the customer still at
 * the screen.
 */
const SHUTDOWN_DELAY_MS = config.paymentPollTimeoutMs + 15_000;

// The fake terminal is the default and needs no wiring. 'http' points at a
// payment gateway over the network — in development, the mock in
// packages/gateway. See PAYMENT_TESTING.md.
if (config.paymentDriver === 'http') setTerminal(new HttpTerminal());

const app = await buildApp({ logger: true });
const cleanup = startSessionCleanup((msg) => app.log.info(msg));
const resolver = startPaymentResolver((msg) => app.log.info(msg));

// app.close() stops accepting connections and waits for in-flight requests,
// then runs these in registration order: stop the reaper, then close the pool
// that both the requests and the reaper were using.
app.addHook('onClose', async () => {
  await cleanup.stop();
  await resolver.stop();
  await closePool();
});

// close-with-grace owns SIGINT/SIGTERM, uncaughtException and
// unhandledRejection. A second signal or a second error exits immediately,
// and the delay bounds a shutdown that hangs.
closeWithGrace({ delay: SHUTDOWN_DELAY_MS, logger: app.log }, async ({ signal, err }) => {
  if (err) app.log.error({ err }, 'shutting down after an unhandled error');
  else app.log.info(`${signal} received, shutting down`);
  await app.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  // The totem's proxy points at this port. If the bind fails silently the UI
  // just shows ECONNREFUSED, which says nothing about the real cause.
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    app.log.error(
      `Port ${config.port} is already in use. Free it, or start with PORT=<other> ` +
        `and point the totem at it via VITE_API_TARGET.`,
    );
  } else {
    app.log.error(err);
  }
  await app.close();
  process.exit(1);
}
app.log.info(
  config.paymentDriver === 'http'
    ? `payment driver: http -> ${config.paymentGatewayUrl} (timeout ${config.paymentHttpTimeoutMs}ms, ${config.paymentHttpRetries} retries)`
    : `payment driver: ${config.paymentDriver}`,
);
