# hookforge

[![npm version](https://img.shields.io/npm/v/hookforge)](https://www.npmjs.com/package/hookforge)
[![CI](https://github.com/muhammad-afan/hookkit/actions/workflows/ci.yml/badge.svg)](https://github.com/muhammad-afan/hookkit/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#bundle-size)
[![license](https://img.shields.io/npm/l/hookforge)](LICENSE)

Verify, deduplicate, and process inbound webhooks. Stripe, Shopify, GitHub, Clerk
and more. Zero runtime dependencies, works everywhere — Node, Bun, Deno, Cloudflare
Workers, Vercel Edge.

> **Status: v0.1.0, pre-release.** Core, all 9 provider adapters (Stripe, GitHub,
> Shopify, Standard Webhooks, Slack, Discord, Twilio, Paddle, and the generic adapter),
> the memory/Redis/Prisma idempotency stores, BullMQ queue handoff, multi-provider
> routing, and the Express/Fastify/NestJS/Next.js framework integrations are implemented
> and tested (422 tests). Not yet published to npm — see `CLAUDE.md` §17 for what's left
> before a tagged 1.0.

## The problem

Verifying a webhook signature is the easy 20%. Here's what teams actually end up
hand-rolling around it:

```ts
// The 40 lines nobody wants to write twice
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const [tPart, v1Part] = sig.split(',');
  const timestamp = tPart.split('=')[1];
  const expectedSig = v1Part.split('=')[1];

  const signedPayload = `${timestamp}.${req.body}`;
  const hmac = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET);
  hmac.update(signedPayload);
  const computed = hmac.digest('hex');

  if (!timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSig))) {
    return res.status(400).send('bad signature');
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return res.status(400).send('stale');
  }

  const event = JSON.parse(req.body);

  // Now hand-roll dedupe, because Stripe retries — and two retries can race:
  const existing = await db.processedEvents.findUnique({ where: { id: event.id } });
  if (existing) return res.status(200).send('already processed');
  await db.processedEvents.create({ data: { id: event.id } }); // not atomic with the check above!

  await handleStripeEvent(event); // if this throws, the row above is now permanently stuck
  res.status(200).send('ok');
});
```

With hookforge:

```ts
const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: process.env.STRIPE_WEBHOOK_SECRET! },
  idempotency: { store: memoryStore() }, // swap for Redis/Prisma in production
  onEvent: async ({ payload }) => handleStripeEvent(payload),
});

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), expressWebhook(receiver));
```

Signature verification, replay-window checks, atomic dedupe, and JSON parsing (with a
prototype-pollution guard) are handled for you — and the dedupe claim is a single atomic
operation, so two concurrent Stripe retries can never both process the same event.

## Install

```bash
npm install hookforge
```

## Quickstart (Stripe + Express)

```ts
import express from 'express';
import { createReceiver } from 'hookforge';
import { stripe } from 'hookforge/stripe';
import { memoryStore } from 'hookforge/stores/memory';
import { expressWebhook } from 'hookforge/express';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: process.env.STRIPE_WEBHOOK_SECRET! },
  idempotency: { store: memoryStore() },
  onEvent: async (event) => {
    console.log('verified event', event.id, event.payload);
  },
});

const app = express();
// ⚠️ ORDER MATTERS: express.raw() must run BEFORE any express.json() middleware.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), expressWebhook(receiver));

app.listen(3000);
```

### Next.js App Router

```ts
// app/api/webhooks/stripe/route.ts
import { createReceiver } from 'hookforge';
import { stripe } from 'hookforge/stripe';
import { nextWebhook } from 'hookforge/next';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: process.env.STRIPE_WEBHOOK_SECRET! },
  onEvent: async (event) => { /* ... */ },
});

export const POST = nextWebhook(receiver);
export const runtime = 'nodejs'; // or 'edge' — both work, no code changes needed
```

### Fastify

```ts
import Fastify from 'fastify';
import { createReceiver } from 'hookforge';
import { stripe } from 'hookforge/stripe';
import { hookkitFastify, hookkitFastifyRawBody } from 'hookforge/fastify';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: process.env.STRIPE_WEBHOOK_SECRET! },
  onEvent: async (event) => { /* ... */ },
});

const fastify = Fastify();
// Scoped to a child plugin so it doesn't disable JSON parsing app-wide.
fastify.register(async (app) => {
  hookkitFastifyRawBody(app);
  app.post('/webhooks/stripe', hookkitFastify(receiver));
});
```

### NestJS

The `@Webhook()` guard verifies and dedupes before your handler runs — by the time your
method executes, the signature is valid, the event isn't a duplicate, and the payload is
parsed.

```ts
// app.module.ts
import { HookkitModule } from 'hookforge/nestjs';
import { stripe } from 'hookforge/stripe';
import { redisStore } from 'hookforge/stores/redis';

@Module({
  imports: [
    HookkitModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService, redis: Redis) => ({
        store: redisStore({ client: redis }),
        providers: {
          stripe: {
            adapter: stripe,
            credentials: { type: 'secret', secret: config.getOrThrow('STRIPE_WEBHOOK_SECRET') },
          },
        },
      }),
    }),
  ],
})
export class AppModule {}
```

```ts
// stripe-webhook.controller.ts
import { Webhook, WebhookEvent } from 'hookforge/nestjs';

@Controller('webhooks')
export class StripeWebhookController {
  @Post('stripe')
  @Webhook('stripe')
  async handle(@WebhookEvent() event: VerifiedEvent<Stripe.Event>) {
    // Guaranteed: signature valid, not a duplicate, payload parsed.
  }
}
```

```ts
// main.ts — required so req.rawBody is populated
const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
```

⚠️ `rawBody: true` silently stops working if you later call
`app.use(json({ limit: '50mb' }))` to raise the body-size limit — it overrides Nest's
parser ([nestjs/nest#10471](https://github.com/nestjs/nest/issues/10471)). Use
`applyRawBodyOnlyTo()` from `hookforge/nestjs` as an escape hatch if you need a custom
limit on non-webhook routes without breaking this.

### Hono, Cloudflare Workers, Vercel Edge, Deno

No dedicated adapter needed — every `Receiver` already has a `fetch(request: Request)`
method, and all of these runtimes hand you a standard `Request`:

```ts
app.post('/webhooks/:provider', async (c) => receiver.fetch(c.req.raw));
```

## Why not just use the Stripe SDK?

`stripe.webhooks.constructEvent` verifies a signature. That's one provider, and it's
where the work *stops*. hookforge adds:

- **Multi-provider** — one interface across Stripe, Shopify, GitHub, and every
  Standard Webhooks-compatible provider (Svix, Clerk, Resend, Polar, WorkOS...).
- **Idempotency** — providers retry, at-least-once. An atomic claim means concurrent
  retries never both process the same event.
- **Fail-closed by design** — missing headers, bad timestamps, or an unreachable
  idempotency store all reject by default. There's no `skipVerification` escape hatch
  to accidentally ship to prod.
- **A real test signer** — `createTestSigner` builds validly-signed requests without a
  live provider account, for every supported adapter.

## How hookforge compares

| | hookforge | Tern | Svix (consumer) |
|---|---|---|---|
| Multi-provider verification | ✅ 9 providers | ✅ (broader provider list today) | ❌ (Standard Webhooks only) |
| Idempotency / dedupe | ✅ atomic claim (memory/Redis/Prisma) | ❌ | ❌ |
| Fast-ack + queue handoff | ✅ (BullMQ) | ❌ | ❌ |
| NestJS module | ✅ (`@Webhook()` guard + decorator) | ❌ | ❌ |
| Test signer | ✅ | ❌ | ❌ |
| Runtime dependencies | 0 | 0 | pulls `standardwebhooks` |

Tern currently supports more providers out of the box — if pure signature verification
across 19+ platforms is all you need today, it's a fine choice. hookforge's bet is that
idempotency, fast-ack, and framework integration are the parts that actually bite teams
in production, and that's where it invests.

## Supported providers (current)

| Provider | Header(s) | Algorithm | Tolerance | Event ID |
|---|---|---|---|---|
| Stripe | `stripe-signature` | HMAC-SHA256, hex | 300s | `id` in body |
| GitHub | `x-hub-signature-256` | HMAC-SHA256, hex | none | `x-github-delivery` |
| Shopify | `x-shopify-hmac-sha256` | HMAC-SHA256, base64 | none | `x-shopify-webhook-id` |
| Standard Webhooks (Svix/Clerk/Resend/Polar/WorkOS) | `webhook-id`/`webhook-timestamp`/`webhook-signature` (or `svix-*`) | HMAC-SHA256, base64 | 300s | `webhook-id` |
| Slack | `x-slack-signature`/`x-slack-request-timestamp` | HMAC-SHA256, hex | 300s | `event_id` in body |
| Discord | `x-signature-ed25519`/`x-signature-timestamp` | Ed25519 | 60s¹ | `id` in body |
| Twilio | `x-twilio-signature` | HMAC-SHA1, base64 | none | `MessageSid`/`CallSid` (form body) |
| Paddle | `paddle-signature` | HMAC-SHA256, hex | 300s | `event_id` in body |
| Generic (`createGenericAdapter`) | you configure it | HMAC (sha1/sha256/sha512), hex or base64 | you configure it | you configure it |

¹ **Discord's tolerance is a hookforge addition, not a Discord requirement.** Discord's own
verification docs only check the signature, not timestamp freshness — their 3-second
interaction-response window already makes replay impractical on their end. hookforge
checks it anyway as free defense-in-depth (the timestamp is already inside the signed
bytes, so enforcing a window costs nothing), using a 60s default rather than the 300s
used elsewhere in this table: Stripe/Slack/Standard/Paddle can legitimately retry
deliveries over several minutes, but a real Discord interaction is never minutes late by
construction, so a wide window would only widen the replay door for no benefit. Override
with `toleranceSeconds` like any other adapter if you need to. See the doc comment on
`discord` in `src/providers/discord.ts` for the full rationale.

PayPal (async network verification) is still on the roadmap — see `CLAUDE.md` in this
repo for the full spec and provider details.

## Idempotency

Every major provider is at-least-once delivery — Stripe *will* send you the same event
twice. hookforge's idempotency stores dedupe with a single atomic claim (never a
get-then-set, which is a classic TOCTOU race that lets two concurrent retries both win).

```ts
import { memoryStore } from 'hookforge/stores/memory';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: '...' },
  idempotency: {
    store: memoryStore(), // dev/single-instance only — see below
    ttlSeconds: 86_400,
    onStoreError: 'fail', // 'fail' (default, safe) or 'allow'
  },
  onHandlerError: 'release', // 'release' (default, retries) or 'keep' (permanently suppresses)
  onEvent: async (event) => { /* ... */ },
});
```

`memoryStore()` is safe because JavaScript is single-threaded — a `Map` has-then-set
check with no `await` in between can't be interleaved. It is **not** safe across
multiple processes or instances (multiple ECS tasks, serverless invocations, etc.). Use
`redisStore`/`prismaStore` for anything running more than one instance.

### Redis (multi-instance, in-memory speed)

```ts
import { redisStore } from 'hookforge/stores/redis';
import Redis from 'ioredis';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: '...' },
  idempotency: { store: redisStore({ client: new Redis(process.env.REDIS_URL) }) },
  onEvent: async (event) => { /* ... */ },
});
```

The claim is a single `SET key value NX EX ttl` — one round trip, atomic on the Redis
server.

### Prisma (durable, SQL-backed)

Add a model to your own `schema.prisma` — hookforge never generates or migrates it for you:

```prisma
model ProcessedWebhookEvent {
  key       String   @id
  createdAt DateTime @default(now())
  expiresAt DateTime
}
```

```ts
import { prismaStore } from 'hookforge/stores/prisma';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: '...' },
  idempotency: { store: prismaStore({ delegate: prisma.processedWebhookEvent }) },
  onEvent: async (event) => { /* ... */ },
});
```

The claim relies on the `@id` unique constraint — a duplicate `create()` throws Prisma's
`P2002`, which the store catches and turns into a normal "already claimed" result. Rows
don't expire on their own the way a Redis TTL does; if you want old rows actually
removed, run a periodic
`prisma.processedWebhookEvent.deleteMany({ where: { expiresAt: { lt: new Date() } } })`.

### True exactly-once: claim and handler in the same transaction

`idempotency.store` above gets you **at-least-once delivery with dedupe** — the claim and
your handler are two separate operations, so a crash between them is possible (rare, but
possible). For genuine exactly-once processing, write the claim and your side effect in
the *same* Prisma transaction instead:

```ts
async function handleStripeEvent(event: VerifiedEvent<Stripe.Event>) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.processedWebhookEvent.create({
        data: { key: `stripe:${event.id}`, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await tx.order.update({
        where: { id: event.payload.data.object.metadata.orderId },
        data: { status: 'paid' },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return; // already processed
    throw err;
  }
}
```

If the order update fails, the whole transaction — including the claim — rolls back, so
the provider's retry will see no claim and try again. This is the one pattern that gets
you real exactly-once semantics.

### Fast-ack + queue handoff

Providers retry on timeout. The correct production pattern is
`verify → dedupe → persist → ack in <1s → process on a queue`, not doing the real work
inline before responding:

```ts
import { bullmqQueue, bullmqWorkerHandler } from 'hookforge/queues/bullmq';
import { Queue, Worker } from 'bullmq';

const receiver = createReceiver({
  adapter: stripe,
  credentials: { type: 'secret', secret: '...' },
  idempotency: { store: redisStore({ client: redis }) },
  enqueue: bullmqQueue({ queue: new Queue('webhooks', { connection: redis }) }),
  // onEvent is NOT called — createReceiver acks (202) immediately after enqueue.
});

new Worker(
  'webhooks',
  bullmqWorkerHandler<Stripe.Event>(async (event) => {
    await handleStripeEvent(event.payload);
  }),
  { connection: redis },
);
```

Ordering is `claim idempotency → enqueue → ack`. If the `queue.add()` call throws,
hookforge releases the claim and returns 503 itself, so the provider retries — an event is
never acked before it's durably queued.

## Testing your webhooks

```ts
import { createTestSigner } from 'hookforge/testing';
import { stripe } from 'hookforge/stripe';

const signer = createTestSigner(stripe, { type: 'secret', secret: 'whsec_test' });
const { body, headers } = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

const result = await receiver.handle({ body, headers });
expect(result.status).toBe('processed');
```

No live provider account, no ngrok tunnel, no manually-computed HMAC in a test fixture.

## Bundle size

| Import | Min+gzip | Budget |
|---|---|---|
| `hookforge` (core only) | 3.23 kB | 3.8 kB |
| `hookforge` + `hookforge/stripe` | 5.07 kB | 6 kB |
| `hookforge` + all 6 MVP providers (Stripe, Shopify, GitHub, Standard Webhooks, Slack, Discord) | 13.15 kB | 15.5 kB |
| Unpacked install size (all subpaths, ESM+CJS+types) | 451 kB | 530 kB |

Enforced in CI via `size-limit` (`.size-limit.js`) and `scripts/check-package-size.mjs` —
a regression that crosses a budget fails the build. Zero runtime dependencies is most of
how this stays small: no transitive `node_modules` weight, ever.

## Error handling

Every error hookforge throws or returns is a typed `HookkitError` subclass with a stable
`code`, an `httpStatus`, and a `retryable` flag:

```ts
if (!result.ok) {
  console.log(result.error.code); // e.g. "invalid_signature"
  console.log(result.error.httpStatus); // 400
}
```

Check `err.code`, not `instanceof` — hookforge ships both ESM and CJS builds, and a
dual-loaded package can produce two separate class instances.

## Troubleshooting

Every error message hookforge produces is written to be actionable on its own, but here's
every code in one place:

| `code` | HTTP | Retryable | Cause |
|---|---|---|---|
| `invalid_signature` | 400 | no | Computed digest didn't match. Usually the body was parsed or re-serialized before hookforge saw it — hookforge needs the *exact* raw bytes. In Express, register `express.raw({type:'application/json'})` on the route **before** any `express.json()` middleware. |
| `missing_signature_header` | 400 | no | A required header (e.g. `stripe-signature`) was absent. This request doesn't look like a genuine webhook from that provider. |
| `malformed_signature_header` | 400 | no | The header was present but couldn't be parsed — wrong format, truncated, or from the wrong provider entirely. |
| `timestamp_out_of_tolerance` | 400 | no | The signed timestamp is outside the replay window. Could be clock skew on your server, or a replayed/captured request. |
| `missing_raw_body` | 500 | no | hookforge never saw the raw bytes — a misconfiguration in *your* app, not the caller's fault, hence the 500 instead of 400. In NestJS, check both that `rawBody: true` is set on `NestFactory.create` **and** that nothing later (e.g. `app.use(json({limit:'50mb'}))`) overrides it — see [nestjs/nest#10471](https://github.com/nestjs/nest/issues/10471). |
| `payload_too_large` | 413 | no | Body exceeded `maxBodyBytes` (default 1 MB), rejected before any hashing — this guard exists so HMAC-over-an-unbounded-body can't be used as a CPU amplification vector. |
| `parse_error` | 400 | no | Signature verified, but the body wasn't valid JSON (or your custom `parse` threw). The signature check passing means the *sender* is who they claim; it says nothing about the body's shape. |
| `duplicate_event` | 200 | — | Not really an error — the event was already processed and got deduplicated. Always a 200 so the provider doesn't escalate retries into disabling your endpoint. |
| `idempotency_store_error` | 503 | yes | The idempotency store (Redis/Prisma) was unreachable. 503 so the provider retries rather than risk double-processing with `onStoreError: 'allow'`. |
| `handler_error` | 500 | yes | Your `onEvent` handler threw. The idempotency claim was released (default `onHandlerError: 'release'`) so the provider's retry will reach your handler again. |
| `enqueue_error` | 503 | yes | The `enqueue` call (e.g. `bullmqQueue`) failed — the event was never durably queued, so hookforge releases the claim and returns 503 instead of acking. |
| `provider_verification_error` | 503 | yes | An async network verification call (e.g. PayPal, once implemented) failed or timed out. |
| `unknown_provider_route` | 404 | no | `createRouter` got a request for a provider key with no registered receiver, or no key at all with `autoDetect` off. |
| `ambiguous_provider` | 400 | no | `createRouter`'s `autoDetect` matched zero or multiple receivers and refused to guess — route explicitly instead. |

## Design decisions worth knowing about

- **`verify()` is async.** hookforge is built entirely on `crypto.subtle` (WebCrypto) so
  it runs unmodified on Node, Bun, Deno, and every edge runtime — WebCrypto has no
  synchronous API. This differs from `stripe.webhooks.constructEvent`, which is sync.
- **Fail closed, always.** Any ambiguity — a missing header, an unparseable timestamp,
  an unreachable idempotency store in strict mode — results in rejection. There is
  deliberately no `skipVerification` flag.
- **Zero runtime dependencies.** Redis/Prisma/BullMQ/NestJS/Express are all optional
  peer dependencies, only required if you use that specific adapter or store.

## Non-goals

- Not a webhook *sender*.
- Not a hosted service or dashboard.
- Not payload normalization across providers — you get a verified raw payload; bring
  your own provider SDK types for it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — in particular, adding a provider adapter is the
highest-leverage contribution path and has a checklist there.

## Security

hookforge verifies requests; it does not protect against a compromised signing secret, a
compromised provider account, or business-logic flaws in your own handler. See
[SECURITY.md](SECURITY.md) for the full threat model and how to report a vulnerability
(use GitHub Private Vulnerability Reporting, not a public issue).

## License

MIT
