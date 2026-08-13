import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSelf, AgentSignal, AgentSignalError, AgentSignalX402 } from '../src/index.js';

/**
 * The rest of the client, which `send.test.ts` does not reach.
 *
 * That file covers the four behaviours with a direct human cost -- waking
 * somebody twice, hammering an API that asked for a pause, mistaking an invoice
 * for a quota wall. This one covers the other thirty-odd methods, where the
 * failures are quieter and just as total: a DELETE sent as a POST, a slug that
 * escapes its path segment, a credential presented under the wrong scheme. None
 * of those throw in development. They 404, or they do the wrong thing to the
 * wrong record, against a live account.
 *
 * Almost everything here asserts the request rather than the response, because
 * the request is the part this package is responsible for. The API's own suite
 * owns what happens after.
 */

const RECIPIENT = 'u_8fk2AbCdEfGhIjKlMnOpQr';

/** A fetch that answers every call from `body` and records what it was asked. */
function recorder(body: unknown = { ok: true }, status = 200) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }> = [];

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const keyed = (fetchImpl: typeof globalThis.fetch) =>
  new AgentSignal({ apiKey: 'as_test_key', baseUrl: 'https://api.example.test', fetch: fetchImpl });

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('alerting a human', () => {
  const sent = { ok: true, id: 'm_1', receipt: 'r_1', deliveries: { total: 1, sent: 1, failed: 0, queued: 0 } };

  /**
   * An alert that is not priority 2 is an ordinary notification wearing the
   * word "alert": it arrives once, respects quiet hours, and waits politely to
   * be noticed. The whole point of the method is the opposite of that.
   */
  it('is priority 2, and repeats for an hour by default', async () => {
    const { impl, calls } = recorder(sent);

    await keyed(impl).alert({ to: RECIPIENT, body: 'production is down' });

    expect(calls[0]!.body).toMatchObject({
      priority: 2,
      retry_seconds: 60,
      expire_seconds: 3600,
    });
  });

  it('lets the caller choose a different cadence', async () => {
    const { impl, calls } = recorder(sent);

    await keyed(impl).alert({
      to: RECIPIENT,
      body: 'slower',
      retry_seconds: 300,
      expire_seconds: 1800,
    });

    expect(calls[0]!.body).toMatchObject({ priority: 2, retry_seconds: 300, expire_seconds: 1800 });
  });

  /**
   * Fails closed. `alertAndWait` is sold as `alert && deploy`, so the answer
   * when nothing can be waited on has to be "not acknowledged" -- and it has to
   * come back immediately rather than after polling a receipt that does not
   * exist.
   */
  it('reports not-acknowledged at once when no receipt was issued', async () => {
    const { impl, calls } = recorder({ ...sent, receipt: null });

    const outcome = await keyed(impl).alertAndWait({ to: RECIPIENT, body: 'unanswerable' });

    expect(outcome.acknowledged).toBe(false);
    expect(outcome.receipt).toBeNull();
    // The send, and nothing else. A poll here would be a request against a null id.
    expect(calls).toHaveLength(1);
  });
});

describe('waiting on a receipt', () => {
  /**
   * The regression this file exists to keep fixed.
   *
   * `alertAndWait` asks the server to hold the request for up to 60 seconds,
   * and the client's default timeout is 15. The client therefore aborted its
   * own wait, the abort looked transient, it retried, and the call finally
   * threw a network error about 45 seconds in -- so "nobody answered" surfaced
   * as a crash, and the CLI exited 1 where it documents 2.
   *
   * Asserted by watching what timeout the request actually asks for, which is
   * the only honest way to see it without waiting a real minute.
   */
  it('gives the request longer than the hold it just asked for', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });

    const { impl, calls } = recorder({ ok: true, acknowledged: false, acked_at: null, waited_ms: 60_000 });

    await keyed(impl).receipt('r_1', { waitSeconds: 60 });

    expect(calls[0]!.url).toContain('?wait=60');
    expect(timeouts[0]!).toBeGreaterThan(60_000);
  });

  it('does not ask for a hold when it was not told to', async () => {
    const { impl, calls } = recorder({ ok: true, acknowledged: true, acked_at: '2026-08-09T00:00:00Z' });

    await keyed(impl).receipt('r_1');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/receipts/r_1');
    expect(calls[0]!.url).not.toContain('wait');
  });
});

describe('groups', () => {
  /**
   * Verbs, because the path alone does not say what happens. `removeFromGroup`
   * and `addToGroup` differ by method on nearly the same URL, and getting that
   * backwards adds a member where it meant to drop one -- which on a group used
   * for on-call means paging somebody who took themselves off it.
   */
  it('uses the method that matches the intent', async () => {
    const { impl, calls } = recorder({ ok: true, groups: [], group: { id: 'g_1', name: 'On call', slug: 'on-call' } });
    const client = keyed(impl);

    await client.groups();
    await client.group('on-call');
    await client.createGroup('On call');
    await client.addToGroup('on-call', RECIPIENT);
    await client.removeFromGroup('on-call', RECIPIENT);
    await client.deleteGroup('on-call');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/groups',
      'GET /v1/groups/on-call',
      'POST /v1/groups',
      'POST /v1/groups/on-call/members',
      `DELETE /v1/groups/on-call/members/${RECIPIENT}`,
      'DELETE /v1/groups/on-call',
    ]);
  });

  /**
   * A slug is caller-supplied and goes straight into a path. Unencoded, a `/`
   * in it addresses a different endpoint than the one the caller named.
   */
  it('encodes a slug rather than letting it change the path', async () => {
    const { impl, calls } = recorder({ ok: true, group: { id: 'g_1', name: 'x', slug: 'x' } });

    await keyed(impl).deleteGroup('a/b c');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/groups/a%2Fb%20c');
  });
});

describe('the keyed client elsewhere', () => {
  it('registers and reads the directory on the paths the API serves', async () => {
    const { impl, calls } = recorder({ ok: true, recipients: [] });
    const client = keyed(impl);

    await client.register({ handle: 'deploy-bot' });
    await client.directory();

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/agents/register');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe('https://api.example.test/v1/agents');
  });

  it('refuses an invalid message locally, without spending a request', async () => {
    const { impl, calls } = recorder();

    await expect(keyed(impl).send({ to: 'not-a-key', body: 'x' } as any)).rejects.toBeInstanceOf(
      AgentSignalError,
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('the paid client', () => {
  const paid = (fetchImpl: typeof globalThis.fetch, credit?: string) =>
    new AgentSignalX402({ credit, baseUrl: 'https://api.example.test', fetch: fetchImpl });

  /**
   * Opening credit is the one call that cannot present a credential, because
   * the credential is what it returns. Sending an empty or stale Authorization
   * here is how an agent with no account gets 401 on the only route designed
   * for it.
   */
  it('opens credit with no credential, then presents what it was given', async () => {
    const { impl, calls } = recorder({
      ok: true,
      credit: { token: 'as_credit_minted', free: 250, paid: 0, total: 250, expires_at: null },
    });

    const client = paid(impl);
    await client.openCredit();
    await client.balance();

    expect(calls[0]!.headers.Authorization).toBe('');
    expect(calls[1]!.headers.Authorization).toBe('Credit as_credit_minted');
  });

  /**
   * The two questions an agent asks *before* it has anything to spend: what
   * things cost, and whether this person can be reached at all. Both have to
   * work with no token, or deciding whether to open credit would itself
   * require credit.
   */
  it('prices packs and quotes a recipient with no credit token at all', async () => {
    const { impl, calls } = recorder({ ok: true, packs: [], free: { deliveries: 250 }, devices: 1 });
    const client = paid(impl);

    await client.packs();
    await client.quote(RECIPIENT);

    expect(calls.map((c) => c.url.replace('https://api.example.test', ''))).toEqual([
      '/v1/x402/packs',
      `/v1/x402/quote/${RECIPIENT}`,
    ]);
    // Nothing to present, so nothing is presented.
    expect(calls.every((c) => c.headers.Authorization === '')).toBe(true);
  });

  /**
   * Everything that spends refuses locally instead. A request that cannot
   * succeed is worth failing before it is sent, and the message names the three
   * ways to fix it rather than returning the API's 401.
   */
  it('refuses to spend without a token, without spending a request', async () => {
    const { impl, calls } = recorder({ ok: true });

    await expect(paid(impl).balance()).rejects.toMatchObject({ code: 'missing_credit' });
    await expect(paid(impl).send({ to: RECIPIENT, body: 'x' })).rejects.toMatchObject({
      code: 'missing_credit',
    });
    expect(calls).toHaveLength(0);
  });

  /**
   * free / paid / total, the three the API reports. `paid` was called
   * `remaining` until it collided with the free block on the opening call and
   * an agent reading its own balance saw zero it had not spent.
   */
  it('reports a balance as free, paid and total', async () => {
    const { impl } = recorder({ ok: true, credit: { free: 248, paid: 500, total: 748 } });

    const balance = await paid(impl, 'as_credit_held').balance();

    expect(balance).toEqual({ free: 248, paid: 500, total: 748 });
  });

  it('encodes a recipient key into the quote path', async () => {
    const { impl, calls } = recorder({ ok: true, devices: 1, costs_deliveries: 1 });

    await paid(impl, 'as_credit_held').quote('u_../../etc');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/x402/quote/u_..%2F..%2Fetc');
  });
});

// ---------------------------------------------------------------------------

describe('an agent acting as itself', () => {
  const self = (fetchImpl: typeof globalThis.fetch) =>
    new AgentSelf({
      credential: 'dev_1.secret',
      baseUrl: 'https://api.example.test',
      fetch: fetchImpl,
    });

  it('will not be constructed without a credential', () => {
    const had = process.env.AGENTSIGNAL_DEVICE_SECRET;
    delete process.env.AGENTSIGNAL_DEVICE_SECRET;
    try {
      expect(() => new AgentSelf({ baseUrl: 'https://api.example.test' })).toThrow(AgentSignalError);
    } finally {
      if (had !== undefined) process.env.AGENTSIGNAL_DEVICE_SECRET = had;
    }
  });

  /**
   * `Device`, not `Bearer`. An agent credential presented as an API key is
   * refused, and the error says "invalid key" -- which sends whoever is
   * debugging it looking for a key that was never the problem.
   */
  it('authenticates as a device rather than as an API key', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [] });

    await self(impl).inbox();

    expect(calls[0]!.headers.Authorization).toBe('Device dev_1.secret');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/devices/me/messages');
  });

  it('answers and marks read on the delivery it was handed', async () => {
    const { impl, calls } = recorder({ ok: true });
    const agent = self(impl);

    await agent.respond('d_1', 0);
    await agent.markRead('d_1');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'POST /v1/devices/me/messages/d_1/respond',
      'POST /v1/devices/me/messages/d_1/read',
    ]);
  });

  /**
   * Three options is the ceiling everywhere else -- the schema, the push
   * payload, the buttons on the notification. Answering "4" is not a thing a
   * human could have chosen, so it is refused here rather than posted.
   */
  it('refuses an answer that was never on offer', async () => {
    const { impl, calls } = recorder({ ok: true });

    await expect(self(impl).respond('d_1', 7)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  /**
   * Spawning is credential minting: the token this returns lets a new agent
   * become a member of a channel. Revoking it has to be a DELETE, because a POST
   * to the same path is how you would create another one.
   */
  it('mints a join token and revokes it with a DELETE', async () => {
    const { impl, calls } = recorder({
      ok: true,
      token: { id: 'jt_1', token: 'as_join_secret', name: 'worker', prefix: 'as_join_1', max_uses: 1, expires_at: '2026-09-01T00:00:00Z', label_ref: 'ops' },
      tokens: [],
    });
    const agent = self(impl);

    const minted = await agent.spawnToken('ops', { name: 'worker', maxUses: 1 });
    await agent.spawnTokens();
    await agent.revokeSpawnToken('jt_1');

    expect(minted.token).toBe('as_join_secret');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'POST /v1/channels/ops/join-tokens',
      'GET /v1/channels/join-tokens',
      'DELETE /v1/channels/join-tokens/jt_1',
    ]);
  });

  it('manages channels on the paths the API serves', async () => {
    const { impl, calls } = recorder({
      ok: true,
      channels: [],
      channel: { id: 'l_1', ref: 'ops', name: 'Ops' },
    });
    const agent = self(impl);

    await agent.channels();
    await agent.createChannel('Ops');
    await agent.addToChannel('ops', 'deploy-bot');
    await agent.removeFromChannel('ops', 'deploy-bot');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/channels',
      'POST /v1/channels',
      'POST /v1/channels/ops/members',
      'DELETE /v1/channels/ops/members/deploy-bot',
    ]);
  });
});
