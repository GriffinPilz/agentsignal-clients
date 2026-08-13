import { describe, expect, it, vi } from 'vitest';
import {
  AgentSignal,
  AgentSignalX402,
  AgentSignalError,
  PaymentRequiredError,
  QuotaExceededError,
  RateLimitedError,
} from '../src/index.js';

/**
 * The promises the README makes, held to.
 *
 * This package shipped with `vitest run --passWithNoTests` and no test files,
 * so `pnpm -r test` printed `packages/sdk test: Done` and proved nothing --
 * 1,300 lines of client, and the line in CI said it was fine. These cover the
 * behaviours somebody would actually be harmed by: waking a person twice,
 * hammering an API that asked for a pause, and mistaking "you must pay" for
 * "you are out of quota".
 */

/** A fetch that answers from a queue and records what it was asked. */
function stubFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses[Math.min(calls.length, responses.length - 1)]!;
    calls.push({
      url: String(url),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...(next.headers ?? {}) },
    });
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

/** The real shape: `u_` and 22 alphanumerics. The SDK validates before it
 * sends, so a placeholder is refused locally and never reaches the stub. */
const RECIPIENT = 'u_8fk2AbCdEfGhIjKlMnOpQr';

const ok = { status: 200, body: { ok: true, id: 'm_1', deliveries: { total: 1, sent: 1, failed: 0, queued: 0 } } };

function client(fetchImpl: typeof globalThis.fetch, maxAttempts = 3) {
  return new AgentSignal({
    apiKey: 'as_test_key',
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    maxAttempts,
    timeoutMs: 5_000,
  });
}

describe('idempotency', () => {
  /**
   * The headline claim, and the one with a human cost when it breaks: a
   * network error mid-flight is indistinguishable from a failure, so a retry
   * without a stable key is how somebody gets woken twice for one event.
   */
  it('reuses one generated key across every retry of a send', async () => {
    const { impl, calls } = stubFetch([{ status: 503 }, { status: 503 }, ok]);

    await client(impl).send({ to: RECIPIENT, body: 'once' });

    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map((c) => c.body.idempotency_key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
  });

  it('sends the caller’s key when one is given, rather than inventing another', async () => {
    const { impl, calls } = stubFetch([ok]);

    await client(impl).send({ to: RECIPIENT, body: 'once', idempotency_key: 'run-4821-step-7' });

    expect(calls[0]!.body.idempotency_key).toBe('run-4821-step-7');
  });
});

describe('retrying', () => {
  it('retries a 5xx and gives up after maxAttempts', async () => {
    const { impl, calls } = stubFetch([{ status: 500, body: { error: { code: 'internal', message: 'boom' } } }]);

    await expect(client(impl, 2).send({ to: RECIPIENT, body: 'x' })).rejects.toBeInstanceOf(AgentSignalError);
    expect(calls).toHaveLength(2);
  });

  /**
   * A 4xx is the caller's mistake. Retrying it delays the error and tells them
   * nothing new, and for a validation failure it is three times the noise.
   */
  it('does not retry a 4xx', async () => {
    const { impl, calls } = stubFetch([
      { status: 400, body: { error: { code: 'invalid_request', message: 'no target' } } },
    ]);

    await expect(client(impl).send({ to: RECIPIENT, body: 'x' })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 and surfaces Retry-After when it finally gives up', async () => {
    const { impl, calls } = stubFetch([
      { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } }, headers: { 'Retry-After': '42' } },
    ]);

    const failure = await client(impl, 2).send({ to: RECIPIENT, body: 'x' }).catch((e) => e);

    expect(failure).toBeInstanceOf(RateLimitedError);
    expect((failure as RateLimitedError).retryAfterSeconds).toBe(42);
    expect(calls).toHaveLength(2);
  });
});

describe('the two kinds of 402', () => {
  /**
   * Both are 402 and they mean opposite things. On a keyed send it is the plan
   * ceiling and there is nothing to do but stop; on the paid path it is an
   * invoice and the right move is to pay it. Collapsing them is how a client
   * ends up retrying forever against a wall.
   */
  it('is a QuotaExceededError on a keyed send, and is not retried', async () => {
    const { impl, calls } = stubFetch([
      { status: 402, body: { error: { code: 'quota_exceeded', message: 'out of deliveries' } } },
    ]);

    await expect(client(impl).send({ to: RECIPIENT, body: 'x' })).rejects.toBeInstanceOf(QuotaExceededError);
    expect(calls).toHaveLength(1);
  });

  it('is never confused with PaymentRequiredError', () => {
    const quota = new QuotaExceededError('out');
    expect(quota).toBeInstanceOf(QuotaExceededError);
    expect(quota).not.toBeInstanceOf(PaymentRequiredError);
    expect(quota.status).toBe(402);
  });
});

describe('what goes on the wire', () => {
  it('authorises with the api key and posts to /v1/messages', async () => {
    const { impl, calls } = stubFetch([ok]);

    await client(impl).send({ to: RECIPIENT, body: 'x' });

    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer as_test_key');
  });

  /**
   * The plaintext must not leave the process. If `body` ever appears alongside
   * `sealed`, the promise of an encrypted send is broken in the one direction
   * nobody would notice -- the message still arrives and still reads correctly.
   */
  it('sends ciphertext and no plaintext body when sealing', async () => {
    const keys = {
      status: 200,
      body: { ok: true, recipient_id: 'r_1', devices: [], without_keys: 0 },
    };
    const { impl, calls } = stubFetch([keys, ok]);

    await client(impl)
      .sendEncrypted({ to: RECIPIENT, body: 'the secret' })
      .catch(() => undefined); // no devices to seal to; the assertion is about what was sent

    for (const call of calls) {
      expect(JSON.stringify(call.body)).not.toContain('the secret');
    }
  });
});

describe('paying instead of being refused', () => {
  /**
   * The other 402. On the paid route it is an invoice carrying the x402
   * envelope, and a caller holding a wallet is meant to pay it and repeat --
   * so it must arrive as PaymentRequiredError with the offer intact, not as
   * the QuotaExceededError its status code would otherwise suggest.
   */
  it('raises PaymentRequiredError carrying the offer, and does not retry it', async () => {
    const { impl, calls } = stubFetch([
      {
        status: 402,
        body: {
          error: 'Payment required',
          accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '1000000' }],
          reason: 'free_allowance_exhausted',
        },
      },
    ]);

    const failure = await new AgentSignalX402({
      credit: 'as_credit_test',
      baseUrl: 'https://api.example.test',
      fetch: impl,
      maxAttempts: 3,
    })
      .send({ to: RECIPIENT, body: 'x' })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(PaymentRequiredError);
    expect(failure).not.toBeInstanceOf(QuotaExceededError);
    // The reason distinguishes "that recipient is out" from "you are out",
    // which the README calls the one surprise of the paid path.
    expect((failure as PaymentRequiredError).reason).toBe('free_allowance_exhausted');
    // An invoice is not a transient failure.
    expect(calls).toHaveLength(1);
  });
});
