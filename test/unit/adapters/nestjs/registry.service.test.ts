import { describe, expect, it, vi } from 'vitest';
import { HooksentinelRegistry } from '../../../../src/adapters/nestjs/registry.service.js';
import { InvalidSignatureError } from '../../../../src/core/errors.js';
import { stripe } from '../../../../src/providers/stripe.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_registry_test' };

describe('HooksentinelRegistry — module-level onError callback', () => {
  it('reportError() invokes the configured onError with the error and request', async () => {
    const onError = vi.fn();
    const registry = new HooksentinelRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
      onError,
    });
    const error = new InvalidSignatureError('stripe');
    const req = { body: new Uint8Array(), headers: {} };

    await registry.reportError(error, req);

    expect(onError).toHaveBeenCalledWith(error, req);
  });

  it('reportError() is a no-op when no onError is configured', async () => {
    const registry = new HooksentinelRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
    });
    const error = new InvalidSignatureError('stripe');

    await expect(
      registry.reportError(error, { body: new Uint8Array(), headers: {} }),
    ).resolves.toBeUndefined();
  });
});

describe('HooksentinelRegistry — unregistered provider name', () => {
  it('buildWebhookRequest throws a clear, actionable error for an unregistered provider', () => {
    const registry = new HooksentinelRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
    });

    expect(() =>
      registry.buildWebhookRequest('shopify', { body: Buffer.from('{}'), headers: {} }),
    ).toThrow(/no provider registered for "shopify".*HooksentinelModule\.forRootAsync/s);
  });

  it('run() throws the same error for an unregistered provider', async () => {
    const registry = new HooksentinelRegistry({
      providers: { stripe: { adapter: stripe, credentials: CREDS } },
    });

    await expect(registry.run('shopify', { body: new Uint8Array(), headers: {} })).rejects.toThrow(
      'no provider registered for "shopify"',
    );
  });
});
