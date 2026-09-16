import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { storeScope } from './routes/stores.js';

/** Stable snake_case codes, matching the ones AppError already uses. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // ADR-003: the payment route polls for up to 30s inside the request.
    requestTimeout: 0,
    connectionTimeout: 0,
    ajv: {
      // Fastify coerces types by default, which would quietly accept
      // `quantity: "2"` as 2. Every param here is a string anyway, so strict
      // types cost nothing and keep the contract exact.
      customOptions: { coerceTypes: false },
    },
  });

  /**
   * Treat an empty body as {} instead of rejecting it. Bodyless POSTs such as
   * .../sessions and .../cancel are legitimate, and a client that sets
   * content-type: application/json on every request — as fetch wrappers
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

  await app.register(healthRoutes);
  // Versioned from the start: once thousands of totems run whatever build they
  // were last updated to, the API has to serve old and new clients side by side.
  await app.register(storeScope, { prefix: '/v1/stores/:storeId' });

  return app;
}
