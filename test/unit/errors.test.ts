import { describe, expect, it } from 'vitest';
import {
  DuplicateEventError,
  HandlerError,
  HookkitError,
  IdempotencyStoreError,
  InvalidSignatureError,
  MalformedSignatureHeaderError,
  MissingRawBodyError,
  MissingSignatureHeaderError,
  ParseError,
  PayloadTooLargeError,
  ProviderVerificationError,
  TimestampOutOfToleranceError,
} from '../../src/core/errors.js';

describe('HookkitError taxonomy', () => {
  it('InvalidSignatureError: 400, non-retryable', () => {
    const err = new InvalidSignatureError('stripe');
    expect(err).toBeInstanceOf(HookkitError);
    expect(err.code).toBe('invalid_signature');
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe('stripe');
    expect(err.message).toContain('stripe');
  });

  it('MissingSignatureHeaderError: 400', () => {
    const err = new MissingSignatureHeaderError('github', 'x-hub-signature-256');
    expect(err.code).toBe('missing_signature_header');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain('x-hub-signature-256');
  });

  it('MalformedSignatureHeaderError: 400', () => {
    const err = new MalformedSignatureHeaderError('stripe', 'stripe-signature');
    expect(err.code).toBe('malformed_signature_header');
    expect(err.httpStatus).toBe(400);
  });

  it('TimestampOutOfToleranceError: 400', () => {
    const err = new TimestampOutOfToleranceError('stripe', 300);
    expect(err.code).toBe('timestamp_out_of_tolerance');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain('300');
  });

  it('MissingRawBodyError: 500, actionable message', () => {
    const err = new MissingRawBodyError();
    expect(err.code).toBe('missing_raw_body');
    expect(err.httpStatus).toBe(500);
    expect(err.message).toContain('express.raw');
  });

  it('PayloadTooLargeError: 413', () => {
    const err = new PayloadTooLargeError(1_000_000);
    expect(err.code).toBe('payload_too_large');
    expect(err.httpStatus).toBe(413);
  });

  it('ParseError: 400', () => {
    const err = new ParseError('stripe', new Error('bad json'));
    expect(err.code).toBe('parse_error');
    expect(err.httpStatus).toBe(400);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('DuplicateEventError: 200, not really an error path', () => {
    const err = new DuplicateEventError('evt_1');
    expect(err.code).toBe('duplicate_event');
    expect(err.httpStatus).toBe(200);
  });

  it('IdempotencyStoreError: 503, retryable', () => {
    const err = new IdempotencyStoreError(new Error('conn refused'));
    expect(err.code).toBe('idempotency_store_error');
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('HandlerError: 500, retryable', () => {
    const err = new HandlerError('stripe', new Error('boom'));
    expect(err.code).toBe('handler_error');
    expect(err.httpStatus).toBe(500);
    expect(err.retryable).toBe(true);
  });

  it('ProviderVerificationError: 503, retryable', () => {
    const err = new ProviderVerificationError('paypal');
    expect(err.code).toBe('provider_verification_error');
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('every error message includes a docs URL where applicable', () => {
    const err = new InvalidSignatureError('stripe');
    expect(err.message).toContain('https://hookkit.dev/errors/invalid_signature');
  });
});
