import { describe, expect, it, vi } from 'vitest';
import { nextWebhook } from '../../src/adapters/next.js';
import { createReceiver } from '../../src/core/receiver.js';
import { stripe } from '../../src/providers/stripe.js';
import { createTestSigner } from '../../src/testing/index.js';

const CREDS = { type: 'secret' as const, secret: 'whsec_next_test' };

describe('nextWebhook (App Router)', () => {
  it('handles a Fetch API Request end-to-end', async () => {
    const onEvent = vi.fn();
    const receiver = createReceiver({ adapter: stripe, credentials: CREDS, onEvent });
    const POST = nextWebhook(receiver);

    const signer = createTestSigner(stripe, CREDS);
    const signed = await signer.sign(JSON.stringify({ id: 'evt_1', type: 'x' }));

    const request = new Request('https://example.com/api/webhooks/stripe', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body as BodyInit,
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'processed', eventId: 'evt_1' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
