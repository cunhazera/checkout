import { buildGateway } from './app.js';

const port = Number(process.env.GATEWAY_PORT ?? 3220);
const host = process.env.GATEWAY_HOST ?? '127.0.0.1';

const app = buildGateway({ logger: true });

try {
  await app.listen({ port, host });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    app.log.error(`Port ${port} is already in use. Start with GATEWAY_PORT=<other>.`);
  } else {
    app.log.error(err);
  }
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
