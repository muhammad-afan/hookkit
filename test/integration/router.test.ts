import { describe, expect, it, vi } from 'vitest';
import { createReceiver } from '../../src/core/receiver.js';
import { createRouter } from '../../src/core/router.js';
import { github } from '../../src/providers/github.js';
import { stripe } from '../../src/providers/stripe.js';
import { createTestSigner } from '../../src/testing/index.js';

const STRIPE_CREDS = { type: 'secret' as const, secret: 'whsec_router_test' };
const GITHUB_CREDS = { type: 'secret' as const, secret: 'github_router_test' };

function buildRouter(opts: { autoDetect?: boolean } = {}) {
  const stripeOnEvent = vi.fn();
  const githubOnEvent = vi.fn();
  const stripeReceiver = createReceiver({
    adapter: stripe,
    credentials: STRIPE_CREDS,
    onEvent: stripeOnEvent,
  });
  const githubReceiver = createReceiver({
    adapter: github,
    credentials: GITHUB_CREDS,
    onEvent: githubOnEvent,
  });
  const router = createRouter({
    receivers: { stripe: stripeReceiver, github: githubReceiver },
    autoDetect: opts.autoDetect,
  });
  return { router, stripeOnEvent, githubOnEvent };
}

describe('createRouter — explicit routing (default, autoDetect: false)', () => {
  it('routes to the correct receiver by explicit provider key', async () => {
    const { router, stripeOnEvent, githubOnEvent } = buildRouter();
    const signer = createTestSigner(stripe, STRIPE_CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const result = await router.handle({ body: signed.body, headers: signed.headers }, 'stripe');

    expect(result.status).toBe('processed');
    expect(stripeOnEvent).toHaveBeenCalledTimes(1);
    expect(githubOnEvent).not.toHaveBeenCalled();
  });

  it('routes independent providers with independent secrets — no cross-talk', async () => {
    const { router, stripeOnEvent, githubOnEvent } = buildRouter();
    const githubSigner = createTestSigner(github, GITHUB_CREDS);
    const signed = await githubSigner.sign(JSON.stringify({ action: 'opened' }));

    const result = await router.handle({ body: signed.body, headers: signed.headers }, 'github');

    expect(result.status).toBe('processed');
    expect(githubOnEvent).toHaveBeenCalledTimes(1);
    expect(stripeOnEvent).not.toHaveBeenCalled();
  });

  it('rejects an unregistered provider key with 404', async () => {
    const { router } = buildRouter();
    const result = await router.handle({ body: new Uint8Array(), headers: {} }, 'shopify');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.httpStatus).toBe(404);
      expect(result.error.code).toBe('unknown_provider_route');
    }
  });

  it('rejects when no provider key is given and autoDetect is off (the default)', async () => {
    const { router } = buildRouter();
    const result = await router.handle({ body: new Uint8Array(), headers: {} });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error.code).toBe('unknown_provider_route');
      expect(result.error.message).toContain('autoDetect');
    }
  });

  it('a wrong signature for the correct provider still fails normally through the router', async () => {
    const { router } = buildRouter();
    const signer = createTestSigner(stripe, { type: 'secret', secret: 'wrong-secret' });
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const result = await router.handle({ body: signed.body, headers: signed.headers }, 'stripe');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error.code).toBe('invalid_signature');
  });

  it('fetch() routes via an explicit providerKey argument', async () => {
    const { router, stripeOnEvent } = buildRouter();
    const signer = createTestSigner(stripe, STRIPE_CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const request = new Request('https://example.com/api/webhooks/stripe', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body as BodyInit,
    });

    const response = await router.fetch(request, 'stripe');

    expect(response.status).toBe(200);
    expect(stripeOnEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createRouter — autoDetect: true', () => {
  it("routes automatically when exactly one provider's requiredHeaders all match", async () => {
    const { router, stripeOnEvent } = buildRouter({ autoDetect: true });
    const signer = createTestSigner(stripe, STRIPE_CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const result = await router.handle({ body: signed.body, headers: signed.headers });

    expect(result.status).toBe('processed');
    expect(stripeOnEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects (does not guess) when zero providers match', async () => {
    const { router } = buildRouter({ autoDetect: true });
    const result = await router.handle({
      body: new Uint8Array(),
      headers: { 'x-totally-unrelated': 'x' },
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.httpStatus).toBe(400);
      expect(result.error.code).toBe('ambiguous_provider');
    }
  });

  it('rejects (does not guess) when multiple providers match', async () => {
    const { router } = buildRouter({ autoDetect: true });
    // A request carrying both providers' required headers at once — genuinely ambiguous.
    const result = await router.handle({
      body: new Uint8Array(),
      headers: { 'stripe-signature': 't=1,v1=x', 'x-hub-signature-256': 'sha256=x' },
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.httpStatus).toBe(400);
      expect(result.error.code).toBe('ambiguous_provider');
    }
  });

  it('an explicit providerKey still takes priority over auto-detection', async () => {
    const { router, githubOnEvent, stripeOnEvent } = buildRouter({ autoDetect: true });
    const signer = createTestSigner(stripe, STRIPE_CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const result = await router.handle({ body: signed.body, headers: signed.headers }, 'stripe');

    expect(result.status).toBe('processed');
    expect(stripeOnEvent).toHaveBeenCalledTimes(1);
    expect(githubOnEvent).not.toHaveBeenCalled();
  });

  it('fetch() auto-detects when no providerKey argument is given', async () => {
    const { router, stripeOnEvent } = buildRouter({ autoDetect: true });
    const signer = createTestSigner(stripe, STRIPE_CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));
    const request = new Request('https://example.com/api/webhooks', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body as BodyInit,
    });

    const response = await router.fetch(request);

    expect(response.status).toBe(200);
    expect(stripeOnEvent).toHaveBeenCalledTimes(1);
  });
});
