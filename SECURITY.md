# Security Policy

hookkit is a security-adjacent library — it verifies inbound webhook signatures. Treat
anything that could weaken that guarantee as a security issue, not a regular bug.

## Supported versions

hookkit is currently pre-1.0 (`0.x`). Only the latest published `0.x` release is
supported with security fixes. Once the API stabilizes at `1.0`, this section will be
updated to track supported major versions individually.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.** Use
[GitHub Private Vulnerability Reporting](https://github.com/muhammad-afan/hookkit/security/advisories/new)
on this repository instead — it's enabled for exactly this purpose and keeps the report
private until a fix ships.

If you're unable to use Private Vulnerability Reporting for some reason, email
afansaeed19971719@gmail.com with details.

Please include:

- The version of hookkit affected.
- Which adapter/store/component is involved.
- A minimal reproduction (a failing test case is ideal).
- The impact you believe this has (e.g. "a forged request would pass verification under
  condition X").

### What to expect

- **Acknowledgement within 48 hours.**
- We'll work with you to understand and confirm the issue, and agree on a disclosure
  timeline.
- **Coordinated disclosure within 90 days** of the initial report, or sooner once a fix
  is released. If a fix needs more than 90 days, we'll communicate why and give you a
  revised timeline rather than going silent.
- Credit in the advisory and release notes, if you'd like it.

## Threat model — what hookkit does and does not protect against

hookkit verifies that a request was signed by a party holding your signing secret (or, for
asymmetric providers, whose private key corresponds to the configured public key), and
that it falls within the configured replay-tolerance window. **That is the entire
guarantee.**

It does **not** protect against:

- **A compromised signing secret.** If your `STRIPE_WEBHOOK_SECRET` (or equivalent) leaks,
  an attacker can forge arbitrarily many validly-signed requests. Secret rotation and
  storage are your responsibility; hookkit's `additionalSecrets` option only helps you
  rotate a secret without downtime, not detect that one has leaked.
- **A compromised provider.** If Stripe's (or any provider's) systems are compromised and
  used to send genuinely-signed malicious payloads, hookkit will verify them — because
  they really were signed with the real secret. Signature verification proves origin, not
  intent.
- **Business-logic flaws in your handler.** hookkit's job ends at handing you a verified,
  deduplicated, parsed payload. What your `onEvent`/`enqueue` handler does with that
  payload — authorization checks, amount validation, idempotent side effects beyond
  hookkit's own dedupe — is entirely up to your code.
- **A malicious payload that is nonetheless validly signed.** A compromised provider
  account (e.g. an attacker with write access to your Stripe dashboard) could configure
  webhooks with attacker-controlled but validly-signed content. Verification doesn't
  imply the payload is "safe" in any deeper sense than "came from the holder of the
  secret."

If your threat model requires protecting against any of the above, you need controls
outside hookkit's scope (secret management, provider account security, handler-level
authorization and validation).

## Security-relevant design commitments

These are enforced by the project, not just documented aspirations — see `CONTRIBUTING.md`
for how they're maintained:

- **Zero runtime dependencies** in core and every provider adapter. Every transitive
  dependency is attack surface; adding one requires a maintainer discussion.
- **`crypto.subtle` only**, never a hand-rolled comparison — `subtle.verify` performs
  constant-time comparison internally, so there is no timing side-channel to get wrong.
- **Fail closed.** Any ambiguity (missing header, unparseable timestamp, unreachable
  idempotency store in strict mode) results in rejection. There is no `skipVerification`
  escape hatch.
- **No dynamic code execution** — no `eval`, no `new Function`, no dynamic `require` of
  user-supplied strings.
- **hookkit does not log anything itself** — there's no built-in logger, so there's no
  hookkit-owned diagnostic output that could leak a secret. Error messages (`HookkitError`
  subclasses) name the provider and the affected header, never the secret or signature
  value. If you log `HookkitError` instances or request headers yourself, make sure your
  own logging doesn't capture the raw `stripe-signature`/`x-hub-signature-256`/etc. header
  values or credential material.
