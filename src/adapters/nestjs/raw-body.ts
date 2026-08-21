import { MissingRawBodyError } from '../../core/errors.js';
import type { HooksentinelHttpRequest } from './types.js';

const DOCS_URL = 'https://hooksentinel.dev/errors/missing_raw_body';

/**
 * Fires at the first request if `req.rawBody` is missing, naming both documented,
 * easy-to-hit NestJS causes explicitly rather than making the developer guess:
 *
 * 1. `rawBody: true` was passed to `NestFactory.create()` but `bodyParser: false` was
 *    also set — rawBody capture requires Nest's built-in body parser to stay enabled.
 * 2. A custom `app.use(json({ limit: '...' }))` (or similar) was registered AFTER
 *    `rawBody: true` was enabled, which silently overrides Nest's raw-body-capturing
 *    parser. See https://github.com/nestjs/nest/issues/10471.
 */
export function assertRawBody(
  req: HooksentinelHttpRequest,
): asserts req is HooksentinelHttpRequest & { rawBody: Buffer } {
  if (Buffer.isBuffer(req.rawBody)) return;

  throw new MissingRawBodyError(
    `hooksentinel: req.rawBody was not available on this NestJS request. Two documented causes: (1) \`rawBody: true\` was passed to NestFactory.create() but \`bodyParser: false\` was also set — raw-body capture requires the built-in body parser to remain enabled. (2) a custom \`app.use(json({ limit: '...' }))\` (or similar) was registered AFTER enabling \`rawBody: true\`, which overrides the parser that captures it — see https://github.com/nestjs/nest/issues/10471. Fix: call NestFactory.create(AppModule, { rawBody: true }) without bodyParser:false, and register any custom body-size-limit middleware BEFORE rawBody is enabled — or use hooksentinel's applyRawBodyOnlyTo() escape hatch to scope raw-body capture to just your webhook routes. See ${DOCS_URL}`,
  );
}

/**
 * Escape hatch for Express-based Nest apps (`NestExpressApplication`) that need a custom
 * body-size limit and can't rely on global `rawBody: true`. Captures the raw body only
 * for the given path(s), independent of any other body-parser middleware registered
 * elsewhere in the app.
 *
 * @example
 * const app = await NestFactory.create<NestExpressApplication>(AppModule);
 * applyRawBodyOnlyTo(app, ['/webhooks/stripe', '/webhooks/shopify']);
 */
export function applyRawBodyOnlyTo(
  app: { use: (path: string | string[], handler: (...args: unknown[]) => void) => unknown },
  paths: string | string[],
): void {
  app.use(paths, (...args: unknown[]) => {
    const req = args[0] as HooksentinelHttpRequest & {
      on: (event: string, cb: (chunk: Buffer) => void) => void;
    };
    const next = args[2] as () => void;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  });
}
