import { describe, expect, it } from 'vitest';
import { PayloadTooLargeError } from '../../src/core/errors.js';
import { fromFetchRequest, normalizeHeaders, toWebhookRequest } from '../../src/core/request.js';

describe('normalizeHeaders', () => {
  it('lowercases header names', () => {
    expect(normalizeHeaders({ 'X-Foo': 'bar' })).toEqual({ 'x-foo': 'bar' });
  });

  it('skips a header whose value is explicitly undefined', () => {
    expect(normalizeHeaders({ 'x-present': 'yes', 'x-absent': undefined })).toEqual({
      'x-present': 'yes',
    });
  });

  it('joins an array-valued (multi-value) header with ", "', () => {
    expect(normalizeHeaders({ 'x-multi': ['a', 'b', 'c'] })).toEqual({ 'x-multi': 'a, b, c' });
  });

  it('normalizes a real Headers instance', () => {
    const headers = new Headers({ 'X-Foo': 'bar' });
    expect(normalizeHeaders(headers)).toEqual({ 'x-foo': 'bar' });
  });
});

describe('toWebhookRequest', () => {
  it('defaults method to POST when omitted', () => {
    const req = toWebhookRequest({ body: '{}', headers: {} });
    expect(req.method).toBe('POST');
  });

  it('uppercases an explicitly provided method', () => {
    const req = toWebhookRequest({ body: '{}', headers: {}, method: 'get' });
    expect(req.method).toBe('GET');
  });

  it('enforces maxBodyBytes before returning', () => {
    expect(() => toWebhookRequest({ body: 'x'.repeat(10), headers: {}, maxBodyBytes: 5 })).toThrow(
      PayloadTooLargeError,
    );
  });

  it('carries the url through unchanged', () => {
    const req = toWebhookRequest({
      body: '{}',
      headers: {},
      url: 'https://example.com/webhooks/stripe',
    });
    expect(req.url).toBe('https://example.com/webhooks/stripe');
  });
});

describe('fromFetchRequest', () => {
  it('7.12: rejects based on a declared Content-Length before ever consuming the body stream (DoS guard)', async () => {
    // The stream errors the moment it's actually consumed (getReader().read() /
    // arrayBuffer()). If fromFetchRequest read the body before checking Content-Length,
    // the rejection reason would be THIS stream error, not PayloadTooLargeError — so
    // asserting the specific error type proves the content-length check runs first,
    // without depending on implementation details of when the stream is "touched".
    const explodesOnConsume = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(
          new Error(
            'the body stream must not be consumed once Content-Length already exceeds the limit',
          ),
        );
      },
    });
    const request = new Request('https://example.com/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-length': '2000000' },
      body: explodesOnConsume,
      duplex: 'half',
    } as RequestInit);

    await expect(fromFetchRequest(request, 1_000_000)).rejects.toThrow(PayloadTooLargeError);
  });

  it('a Content-Length within the limit is not rejected early, and the body is read normally', async () => {
    const payload = JSON.stringify({ id: 'evt_1' });
    const request = new Request('https://example.com/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-length': String(Buffer.byteLength(payload)) },
      body: payload,
    });

    const req = await fromFetchRequest(request, 1_000_000);
    expect(new TextDecoder().decode(req.body)).toBe(payload);
  });

  it('a non-numeric Content-Length does not crash — falls through to the post-read size check', async () => {
    const payload = '{}';
    const request = new Request('https://example.com/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
      body: payload,
    });

    const req = await fromFetchRequest(request, 1_000_000);
    expect(new TextDecoder().decode(req.body)).toBe(payload);
  });

  it('7.24: a zero-length body does not crash and produces an empty Uint8Array', async () => {
    const request = new Request('https://example.com/webhooks/stripe', { method: 'POST' });
    const req = await fromFetchRequest(request, 1_000_000);
    expect(req.body).toHaveLength(0);
  });

  it('carries method and url through from the Fetch Request', async () => {
    const request = new Request('https://example.com/webhooks/stripe?x=1', {
      method: 'POST',
      body: '{}',
    });
    const req = await fromFetchRequest(request);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.com/webhooks/stripe?x=1');
  });
});
