import {
  seal,
  sendMessageSchema,
  type DeviceKey,
  type RegisterAgentInput,
  type SendMessageInput,
} from '@agentsignal/core';

export const DEFAULT_BASE_URL = 'https://api.agentsignal.net';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentSignalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentSignalError';
  }
}

/** The month's quota is spent. Distinct so callers can react rather than log. */
export class QuotaExceededError extends AgentSignalError {
  constructor(message: string, readonly wouldSend?: number) {
    super('quota_exceeded', message, 402);
    this.name = 'QuotaExceededError';
  }
}

export class RateLimitedError extends AgentSignalError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super('rate_limited', message, 429);
    this.name = 'RateLimitedError';
  }
}

/**
 * A pay-as-you-go send needs paying for.
 *
 * Deliberately not a `QuotaExceededError`, which is also a 402. That one means
 * "this account is over its plan and there is nothing you can do from here".
 * This one means "here is the price, pay it and try again" -- opposite advice,
 * and an agent that conflates them either gives up when it could have paid or
 * retries forever when it cannot.
 */
export class PaymentRequiredError extends AgentSignalError {
  constructor(
    message: string,
    /** The x402 envelope, for a client that can sign a payment. */
    readonly accepts: unknown[],
    /** What is on sale, and how many deliveries each buys. */
    readonly packs: CreditPack[],
    /**
     * Why it was refused, when the answer is not the obvious one.
     * `free_allowance_exhausted` means this RECIPIENT is out of free traffic
     * for the month, not that you are out of credit -- your token still works
     * elsewhere.
     */
    readonly reason?: string,
  ) {
    super('payment_required', message, 402);
    this.name = 'PaymentRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendResult {
  id: string;
  receipt: string | null;
  replayed: boolean;
  sandbox?: boolean;
  deliveries: {
    total: number;
    sent: number;
    failed: number;
    queued: number;
  };
}

export interface AgentSignalOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Attempts for transient failures. 1 disables retrying. */
  maxAttempts?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RegisterAgentResult {
  ok: true;
  /** False when this handle was already registered: a restart, not a new agent. */
  created: boolean;
  agent: {
    key: string;
    handle: string;
    name: string;
    description: string | null;
    capabilities: string[];
  };
  instance: { id: string; instance_id: string };
  /** `<instance_id>.<secret>`, shown once. Sent as `Authorization: Device …`. */
  device_secret: string;
  /** Null unless an `endpoint` was given; there is nothing to verify without one. */
  webhook_secret: string | null;
}

export interface DirectoryEntry {
  key: string;
  handle: string | null;
  name: string;
  is_agent: boolean;
  description: string | null;
  capabilities: string[];
  devices: number;
  /** False means a send is accepted and delivered nowhere. */
  reachable: boolean;
  last_seen_at: string | null;
}

export interface GroupSummary {
  slug: string;
  name: string;
  members: number;
  /** Members with no device. They accept a send and receive nothing. */
  unreachable: number;
  /** What one send to this group costs — one per device, across all members. */
  deliveries: number;
  created_at: string;
}

export interface GroupMember {
  key: string;
  handle: string | null;
  name: string;
  is_agent: boolean;
  devices: number;
  reachable: boolean;
}

export interface DirectoryResult {
  ok: true;
  channel: { name: string; ref: string; is_sandbox: boolean };
  recipients: DirectoryEntry[];
}

export class AgentSignal {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AgentSignalOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AGENTSIGNAL_API_KEY;
    if (!apiKey) {
      throw new AgentSignalError(
        'missing_api_key',
        'Pass an apiKey, or set AGENTSIGNAL_API_KEY.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Send a notification.
   *
   * If no idempotency key is supplied, one is generated and reused across
   * retries. That is the whole point: a network error mid-flight is
   * indistinguishable from a failure, and retrying without a stable key is how
   * an agent wakes someone up twice for the same event.
   */
  async send(input: SendMessageInput): Promise<SendResult> {
    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();

    return this.request<SendResult>('/v1/messages', {
      ...parsed.data,
      idempotency_key: idempotencyKey,
    });
  }

  /**
   * Send end-to-end encrypted, so neither we nor Apple can read it.
   *
   * Two round trips instead of one: the sender has to fetch the recipient's
   * device keys before it can seal anything. That is inherent -- encrypting to
   * someone requires knowing what to encrypt to -- and it is why this is a
   * separate method rather than a flag on `send`. A one-line curl cannot do
   * this, and pretending otherwise would be worse than saying so.
   *
   * The message vanishes once every device that received it has been opened
   * and confirmed.
   *
   * The honest limit: we serve the public keys this seals against, so a
   * dishonest server could hand back one it holds. This defends against
   * database dumps, Apple, and casual reading -- not against us mounting an
   * active attack. That needs the recipient to verify a key fingerprint out of
   * band, which nothing here does yet.
   */
  async sendEncrypted(
    input: SendMessageInput,
  ): Promise<SendResult & { sealed_for: number; without_keys: number }> {
    if (!input.to) {
      throw new AgentSignalError(
        'invalid_request',
        'Encrypted messages address one recipient key. Groups and broadcasts cannot be sealed, because every device needs its own wrapped key.',
      );
    }

    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const keys = await this.request<{
      devices: DeviceKey[];
      without_keys: number;
    }>(`/v1/recipients/${encodeURIComponent(input.to)}/keys`, undefined, 'GET');

    if (keys.devices.length === 0) {
      throw new AgentSignalError(
        'no_encryptable_devices',
        keys.without_keys > 0
          ? `That person has ${keys.without_keys} device(s), but none have published an encryption key yet. They need a build of the app that supports encrypted messages.`
          : 'That person has no devices registered.',
      );
    }

    if (parsed.data.body === undefined) {
      // Only reachable if a caller hands this method something already
      // sealed. Sealing twice would encrypt the ciphertext.
      throw new AgentSignalError(
        'invalid_request',
        'sendEncrypted takes a plaintext `body` and seals it for you.',
      );
    }

    const { sealed, skipped } = await seal(parsed.data.body, keys.devices);

    if (sealed.keys.length === 0) {
      throw new AgentSignalError(
        'no_encryptable_devices',
        'None of that person’s device keys could be used.',
      );
    }

    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();

    const result = await this.request<SendResult>('/v1/messages', {
      ...parsed.data,
      // The plaintext never leaves this process.
      body: undefined,
      sealed,
      idempotency_key: idempotencyKey,
    });

    return {
      ...result,
      sealed_for: sealed.keys.length,
      // Devices that will not get this one, so a caller who cares can notice
      // rather than assume everybody was reached.
      without_keys: keys.without_keys + skipped.length,
    };
  }

  /**
   * Send an emergency alert that repeats until a human acknowledges it.
   *
   * Defaults chosen so the common case needs no arguments: re-alert every
   * minute, give up after an hour.
   */
  async alert(
    input: Omit<SendMessageInput, 'priority'> & {
      retry_seconds?: number;
      expire_seconds?: number;
    },
  ): Promise<SendResult> {
    return this.send({
      retry_seconds: 60,
      expire_seconds: 3600,
      ...input,
      priority: 2,
    });
  }

  /**
   * Alert a human and block until they acknowledge, or until the alert expires.
   *
   * This is the human-in-the-loop primitive: an agent that needs sign-off can
   * await this and act on the answer. Returns false on expiry, so a caller that
   * ignores the result fails closed rather than proceeding unapproved.
   */
  async alertAndWait(
    input: Parameters<AgentSignal['alert']>[0] & { pollSeconds?: number },
  ): Promise<{ acknowledged: boolean; receipt: string | null; result: SendResult }> {
    const { pollSeconds = 5, ...rest } = input;
    const result = await this.alert(rest);

    if (!result.receipt) {
      return { acknowledged: false, receipt: null, result };
    }

    const expireSeconds = rest.expire_seconds ?? 3600;
    const deadline = Date.now() + expireSeconds * 1000;

    /**
     * The server holds the request open, so an acknowledgement comes back as
     * fast as it was made rather than on the next tick of a poll.
     * `pollSeconds` survives only as the fallback cadence for a server that
     * does not know `?wait=` yet -- an older deployment, or a self-hosted one.
     */
    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const receipt = await this.receipt(result.receipt, {
        waitSeconds: Math.min(remaining, 60),
      });
      if (receipt.acknowledged) {
        return { acknowledged: true, receipt: result.receipt, result };
      }
      // A server that ignored the wait would spin here, so this keeps the old
      // pacing for that case and costs nothing when the wait was honoured.
      if (receipt.waited_ms === undefined) {
        await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
      }
    }

    return { acknowledged: false, receipt: result.receipt, result };
  }

  /** Current state of an emergency receipt. */
  async receipt(
    receiptId: string,
    options: { waitSeconds?: number } = {},
  ): Promise<{ acknowledged: boolean; acked_at: string | null; waited_ms?: number }> {
    const wait = options.waitSeconds ? Math.floor(options.waitSeconds) : 0;
    const suffix = wait ? `?wait=${wait}` : '';
    /**
     * The request has to outlive the hold it just asked for.
     *
     * `timeoutMs` defaults to 15s and `alertAndWait` asks the server to hold
     * for up to 60, so the client aborted its own wait, `httpRequest` treated
     * the abort as transient and retried it, and after maxAttempts the whole
     * call threw. `alertAndWait` therefore never returned "not acknowledged"
     * -- it raised a network error roughly 45 seconds in, and the CLI exited 1
     * where it documents 2. Nobody saw it because nothing tested the path
     * where a human does not answer.
     */
    return this.request(
      `/v1/receipts/${encodeURIComponent(receiptId)}${suffix}`,
      undefined,
      'GET',
      wait ? wait * 1000 + 5_000 : undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Being an agent, and finding the others
  // -------------------------------------------------------------------------

  /**
   * Join this channel as an addressable agent, or rejoin after a restart.
   *
   * Idempotent on `handle`: the same handle is the same agent, so restarting
   * does not create a second one. Without that the directory fills with ghosts
   * and nothing can tell which of five `deploy-bot`s to send to.
   *
   * The returned `device_secret` is shown once. Hold it and an agent can read
   * its own inbox; lose it and the fix is to register again.
   */
  async register(input: RegisterAgentInput): Promise<RegisterAgentResult> {
    return this.request('/v1/agents/register', input);
  }

  /**
   * Who else is here, and what they do.
   *
   * `description` and `capabilities` are what a caller chooses on, and
   * `reachable` is what stops it reporting success for a message nobody will
   * ever read -- a recipient with no device accepts a send and delivers it
   * nowhere.
   */
  async directory(
    options: { capability?: string; agentsOnly?: boolean } = {},
  ): Promise<DirectoryResult> {
    const query = new URLSearchParams();
    if (options.capability) query.set('capability', options.capability);
    if (options.agentsOnly) query.set('agents_only', 'true');
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.request(`/v1/agents${suffix}`, undefined, 'GET');
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /**
   * Every group in this channel, and what a send to each would cost.
   *
   * `deliveries` is the number worth reading before you fan out: a group of
   * 200 people with two devices each is 400 deliveries off the plan, every
   * time. `unreachable` counts members nothing is listening to, which in a
   * group of fifty is invisible unless something counts it.
   */
  async groups(): Promise<GroupSummary[]> {
    const result = await this.request<{ groups: GroupSummary[] }>('/v1/groups', undefined, 'GET');
    return result.groups;
  }

  /** One group, and who is in it. */
  async group(slug: string): Promise<{ group: { slug: string; name: string }; members: GroupMember[] }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}`, undefined, 'GET');
  }

  /**
   * Make a group. The slug is derived from the name unless you give one, and
   * the slug is what you send to.
   */
  async createGroup(name: string, slug?: string): Promise<{ id: string; name: string; slug: string }> {
    const result = await this.request<{ group: { id: string; name: string; slug: string } }>(
      '/v1/groups',
      { name, ...(slug ? { slug } : {}) },
    );
    return result.group;
  }

  /** Removes the grouping, not the people in it. */
  async deleteGroup(slug: string): Promise<{ ok: true }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}`, undefined, 'DELETE');
  }

  /** `recipient` is a recipient key, a handle, or an id. */
  async addToGroup(slug: string, recipient: string): Promise<{ ok: true }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}/members`, { recipient });
  }

  async removeFromGroup(slug: string, recipient: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(recipient)}`,
      undefined,
      'DELETE',
    );
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'DELETE' = 'POST',
    timeoutMs?: number,
  ): Promise<T> {
    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: `Bearer ${this.apiKey}`,
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      // On a keyed send a 402 is the plan ceiling, and there is nothing the
      // caller can do about it from here.
      on402: (message, payload) => {
        const details = payload?.error?.details as { would_send?: number } | undefined;
        throw new QuotaExceededError(message, details?.would_send);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared transport
//
// Both clients retry the same way against the same API; only the credential
// and the meaning of a 402 differ. Keeping one copy means a fix to the backoff
// cannot land on the keyed path and miss the paid one.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  error?: { code: string; message: string; details?: unknown };
}

interface RequestSpec {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  authorization: string;
  body?: unknown;
  maxAttempts: number;
  timeoutMs: number;
  on402: (message: string, payload: ErrorPayload | null) => never;
  /** Given the raw response before its body is read. Used to catch a minted token. */
  onResponse?: (response: Response) => void;
}

async function httpRequest<T>(spec: RequestSpec): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < spec.maxAttempts; attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff with jitter, so a fleet of agents retrying after
      // the same outage does not arrive in lockstep.
      const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise((r) => setTimeout(r, base + Math.random() * 250));
    }

    try {
      const response = await spec.fetchImpl(spec.url, {
        method: spec.method,
        headers: {
          Authorization: spec.authorization,
          'Content-Type': 'application/json',
          'User-Agent': 'agentsignal-sdk',
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: AbortSignal.timeout(spec.timeoutMs),
      });

      spec.onResponse?.(response);

      if (response.ok) {
        return (await response.json()) as T;
      }

      const payload = (await response.json().catch(() => null)) as ErrorPayload | null;

      const code = payload?.error?.code ?? 'internal';
      const message = payload?.error?.message ?? `Request failed (${response.status}).`;

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After') ?? '1');
        lastError = new RateLimitedError(message, retryAfter);
        continue;
      }

      if (response.status === 402) {
        spec.on402(message, payload);
      }

      // 4xx other than the two above is our caller's mistake; retrying it
      // just delays the error.
      if (response.status < 500) {
        throw new AgentSignalError(code, message, response.status, payload?.error?.details);
      }

      lastError = new AgentSignalError(code, message, response.status);
    } catch (error) {
      if (error instanceof AgentSignalError && error.status && error.status < 500) {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError instanceof AgentSignalError) throw lastError;
  throw new AgentSignalError(
    'network_error',
    lastError instanceof Error ? lastError.message : 'Request failed.',
  );
}

// ---------------------------------------------------------------------------
// Pay as you go
// ---------------------------------------------------------------------------

export interface CreditPack {
  code: string;
  name: string;
  price_micros: number;
  deliveries: number;
}

export interface CreditBalance {
  /** Deliveries granted rather than bought. Spent first. */
  free: number;
  /** Deliveries bought with a pack. */
  paid: number;
  /** `free + paid` -- what you can actually send before paying again. */
  total: number;
}

export interface OpenCreditResult extends CreditBalance {
  /**
   * `as_credit_…`. Returned by the call that mints it and never retrievable
   * again — exactly like an API key. Persist it before you do anything else.
   */
  token: string;
  expires_at: string | null;
}

export interface X402Quote {
  ok: true;
  /** Devices this recipient has. Each one is a delivery. */
  devices: number;
  costs_deliveries: number;
  free: {
    /** False when the channel declines unpaid sends. Paid sends still work. */
    accepted: boolean;
    /** Free deliveries this recipient will still absorb this window. */
    allowance_remaining: number;
  };
  packs: CreditPack[];
  network: string;
  asset: string;
}

export interface X402SendResult {
  ok: true;
  id: string;
  receipt: string | null;
  replayed: boolean;
  deliveries: { total: number; sent: number; failed: number; queued: number };
  credit: {
    /** Present only on the response that minted it. */
    token?: string;
    /** Free deliveries left after this send. */
    free: number;
    /** Bought deliveries left after this send. */
    paid: number;
    /** Which balance this send actually came out of. */
    spent: { free: number; paid: number };
  };
}

export interface X402Options {
  /**
   * An existing credit token. Omit and call `openCredit()` to be given one,
   * or use `AgentSignalX402.open()` to do both in a line.
   */
  credit?: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  /**
   * The fetch used to reach us.
   *
   * To buy a pack, pass one already wrapped by an x402 client -- typically
   * `wrapFetchWithPayment(fetch, account)` from `x402-fetch`. That wrapper
   * answers the 402 and repeats the request with a signed payment, so `send`
   * simply succeeds and the bought token comes back on it. This SDK never sees
   * a private key, never signs, and never touches a chain; leaving that to a
   * fetch you supply is the only arrangement where that stays true.
   *
   * With a plain fetch, a send that needs paying for throws
   * `PaymentRequiredError` carrying the offer.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Sending with no account, no API key and — to start with — no wallet.
 *
 * A separate client rather than a mode on `AgentSignal`, because almost
 * nothing carries over: a different credential, different endpoints, and a 402
 * that means "pay me" rather than "you are over your plan". Folding them
 * together would mean an `AgentSignal` whose constructor no longer insists on
 * a key, which is how a typo becomes an unauthenticated client that fails
 * three calls later.
 */
export class AgentSignalX402 {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: X402Options = {}) {
    this.token = options.credit ?? process.env.AGENTSIGNAL_CREDIT;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Open a token and hand back a client already holding it. */
  static async open(options: X402Options = {}): Promise<AgentSignalX402> {
    const client = new AgentSignalX402(options);
    await client.openCredit();
    return client;
  }

  /** The token in use, so a caller can persist one that was minted here. */
  get credit(): string | undefined {
    return this.token;
  }

  /**
   * Get a credit token with the free block on it.
   *
   * No payment, no wallet, no account. The token it returns is shown once and
   * is adopted by this client; store it, or the next process starts over.
   */
  async openCredit(): Promise<OpenCreditResult> {
    const result = await this.request<{ ok: true; credit: OpenCreditResult }>(
      '/v1/x402/credits',
      undefined,
      'POST',
      // Nothing to authenticate with yet; that is the point of the call.
      false,
    );
    this.token = result.credit.token;
    return result.credit;
  }

  /** What is left, without having to send something to find out. */
  async balance(): Promise<CreditBalance> {
    const result = await this.request<{ ok: true; credit: CreditBalance }>(
      '/v1/x402/credits',
      undefined,
      'GET',
    );
    return result.credit;
  }

  /** What is on sale, and how big the free block is. */
  async packs(): Promise<{
    packs: CreditPack[];
    free: { deliveries: number; open: string; note: string };
    network: string;
    asset: string;
  }> {
    return this.request('/v1/x402/packs', undefined, 'GET', false);
  }

  /**
   * What a send to this recipient would cost, and whether free credit is
   * welcome there — without committing to one. Needs no credit token.
   */
  async quote(recipientKey: string): Promise<X402Quote> {
    return this.request(
      `/v1/x402/quote/${encodeURIComponent(recipientKey)}`,
      undefined,
      'GET',
      false,
    );
  }

  /**
   * Send, drawing on this token.
   *
   * Free credit is spent before bought credit. With a payment-wrapped fetch a
   * send that runs past the balance buys a pack and goes through; with a plain
   * one it throws `PaymentRequiredError` carrying what it would have cost.
   */
  async send(input: SendMessageInput): Promise<X402SendResult> {
    if (!input.to || !input.to.startsWith('u_')) {
      throw new AgentSignalError(
        'invalid_request',
        'Pay-as-you-go sends address one recipient key. Set "to" to a u_… key. Groups and broadcasts are not payable, so one key never buys a whole channel.',
      );
    }

    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const result = await this.request<X402SendResult>('/v1/x402/messages', {
      ...parsed.data,
      idempotency_key: input.idempotency_key ?? crypto.randomUUID(),
    });

    // A send that paid its way mints a token when the caller had none. Adopt
    // it, or the money bought a balance this client cannot reach.
    if (result.credit?.token) this.token = result.credit.token;

    return result;
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST',
    needsCredit = true,
  ): Promise<T> {
    if (needsCredit && !this.token) {
      throw new AgentSignalError(
        'missing_credit',
        'No credit token. Call openCredit() for a free block, set AGENTSIGNAL_CREDIT, or pass one as `credit`.',
      );
    }

    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: this.token ? `Credit ${this.token}` : '',
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: this.timeoutMs,
      // Here a 402 is an offer rather than a wall. It carries the x402
      // envelope, so a caller holding a wallet can pay it and repeat.
      on402: (message, payload) => {
        const body = payload as
          | (ErrorPayload & { accepts?: unknown[]; error?: string })
          | null;
        // A 402 from the paid route is the x402 envelope itself, not our
        // usual `{ error: { code, message } }` shape.
        const envelope = body as unknown as {
          accepts?: unknown[];
          error?: string | { message?: string };
          packs?: CreditPack[];
          reason?: string;
        } | null;
        const text =
          typeof envelope?.error === 'string' ? envelope.error : message;
        throw new PaymentRequiredError(
          text,
          envelope?.accepts ?? [],
          envelope?.packs ?? [],
          envelope?.reason,
        );
      },
      onResponse: (response) => {
        // Also arrives in the body, but a caller that only reads headers on a
        // 402-then-200 exchange still gets it.
        const minted = response.headers.get('X-Credit-Token');
        if (minted) this.token = minted;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// An agent acting as itself
// ---------------------------------------------------------------------------

export interface InboxMessage {
  delivery_id: string;
  message_id: string;
  title: string | null;
  body: string | null;
  priority: number;
  options: string[] | null;
  created_at: string;
  read_at: string | null;
}

export interface AgentChannel {
  ref: string;
  name: string;
  slug: string;
  /** The channel this agent lives in. It cannot leave this one. */
  is_home: boolean;
  is_sandbox: boolean;
  /** True if this agent created it, and therefore manages who is in it. */
  mine: boolean;
  members: number;
}

export interface AgentSelfOptions {
  /** `<instance_id>.<secret>`, from the register call. Shown once. */
  credential?: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * The other half of the loop.
 *
 * `AgentSignal` sends; this receives, and manages the channels an agent is
 * reachable in. Separate because the credential is different in kind: an API
 * key answers "which channel am I sending through", and a device credential
 * answers "who am I". Every call here is about the second question, and
 * answering it with a key would make the creator of a channel whoever handed the
 * key out rather than the agent that asked for it.
 *
 * The credential comes back from `AgentSignal.register()` and is shown once.
 */
/** A join token an agent minted. `token` is present exactly once, at creation. */
export interface SpawnedToken {
  id: string;
  token: string;
  name: string;
  prefix: string;
  max_uses: number | null;
  expires_at: string;
  label_ref: string;
}

export class AgentSelf {
  private readonly credential: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AgentSelfOptions = {}) {
    const credential = options.credential ?? process.env.AGENTSIGNAL_DEVICE_SECRET;
    if (!credential) {
      throw new AgentSignalError(
        'missing_credential',
        'Pass the `credential` from register(), or set AGENTSIGNAL_DEVICE_SECRET.',
      );
    }

    this.credential = credential;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Join a channel with a join token, and come back as a working agent.
   *
   * The whole bootstrap in one call. A join token can create an agent and
   * nothing else, so this is the only thing you can do with one -- which is
   * the point: the value you paste into a fleet's environment cannot page
   * anybody if it leaks.
   *
   * Idempotent on `handle`. The same handle is the same agent, so a restart
   * rejoins rather than filling the directory with ghosts -- but the
   * credential is minted fresh each time, so keep the one you get back.
   */
  static async join(
    joinToken: string,
    input: RegisterAgentInput,
    options: Omit<AgentSelfOptions, 'credential'> = {},
  ): Promise<{ agent: AgentSelf; registration: RegisterAgentResult }> {
    const baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    const registration = await httpRequest<RegisterAgentResult>({
      fetchImpl: options.fetch ?? globalThis.fetch,
      url: `${baseUrl}/v1/agents/register`,
      method: 'POST',
      authorization: `Join ${joinToken}`,
      body: input,
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMs: options.timeoutMs ?? 15_000,
      on402: (message) => {
        throw new AgentSignalError('payment_required', message, 402);
      },
    });

    return {
      agent: new AgentSelf({ ...options, credential: registration.device_secret }),
      registration,
    };
  }

  /**
   * What has arrived.
   *
   * Nothing is pushed to an agent with no address of its own: the delivery row
   * is the delivery, and this is the agent coming to ask. Pass `since` with the
   * last `created_at` you handled so a restart does not replay the lot.
   */
  async inbox(options: { since?: string; limit?: number } = {}): Promise<InboxMessage[]> {
    const query = new URLSearchParams();
    if (options.since) query.set('since', options.since);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : '';

    const result = await this.request<{ messages: InboxMessage[] }>(
      `/v1/devices/me/messages${suffix}`,
      undefined,
      'GET',
    );
    return result.messages;
  }

  /**
   * Answer a message that asked a question.
   *
   * Takes the answer as its text -- the words the sender offered -- or as the
   * index, if you already have it. The API takes only the index: this used to
   * send `{ option: "Go ahead" }` where it wanted `{ option_index: 0 }`, so
   * every answer sent through this SDK, the CLI, and the MCP server was
   * rejected with a 400. The whole documented agent-answers-a-question path
   * had never worked.
   *
   * Resolving the text costs one extra request, because the index only means
   * something against that message's own options and the caller holding a
   * string does not necessarily have them. Pass a number, or `options`, to skip
   * it.
   */
  async respond(
    deliveryId: string,
    answer: string | number,
    options?: string[],
  ): Promise<{ ok: true }> {
    const index =
      typeof answer === 'number'
        ? answer
        : await this.indexOfOption(deliveryId, answer, options);

    if (!Number.isInteger(index) || index < 0 || index > 2) {
      throw new Error(
        `option_index must be 0, 1 or 2 -- got ${JSON.stringify(index)}`,
      );
    }

    return this.request(
      `/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/respond`,
      { option_index: index },
    );
  }

  /**
   * Which of the offered answers this is, matched forgivingly.
   *
   * Case and surrounding space are ignored: an agent echoing back an option it
   * was shown should not fail on capitalisation, and a human at the CLI should
   * not have to match punctuation exactly. Anything that still does not match
   * is an error naming what was actually on offer, rather than a guess.
   */
  private async indexOfOption(
    deliveryId: string,
    answer: string,
    supplied?: string[],
  ): Promise<number> {
    let options = supplied;

    if (!options) {
      const message = (await this.inbox()).find((m) => m.delivery_id === deliveryId);
      if (!message) {
        throw new Error(
          `No message ${deliveryId} in this agent's inbox, so there is nothing to answer.`,
        );
      }
      options = message.options ?? [];
    }

    const wanted = answer.trim().toLowerCase();
    const index = options.findIndex((o) => o.trim().toLowerCase() === wanted);

    if (index === -1) {
      throw new Error(
        options.length === 0
          ? `Message ${deliveryId} did not ask a question, so there is no answer to give.`
          : `"${answer}" is not one of the answers offered: ${options
              .map((o) => `"${o}"`)
              .join(', ')}.`,
      );
    }

    return index;
  }

  /** Mark it handled. For an emergency alert this is the acknowledgement. */
  async markRead(deliveryId: string): Promise<{ ok: true }> {
    return this.request(`/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/read`, {});
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send as yourself.
   *
   * Reaches whoever you share a channel with, and nothing else -- the same rule
   * the directory answers by. The message records which agent sent it, so a
   * delivery log can name `deploy-bot` rather than the one key a whole fleet
   * shares.
   *
   * Which channel it goes through is resolved from the ones you and the target
   * share; name one with `channel` when you are in several together and it
   * matters which brand the notification carries.
   */
  async send(input: SendMessageInput & { channel?: string }): Promise<SendResult> {
    const { channel, ...message } = input;

    if (!message.to) {
      throw new AgentSignalError(
        'invalid_request',
        'Send to one recipient key. Groups and broadcasts belong to whoever owns the channel, not to an agent that joined it.',
      );
    }

    const parsed = sendMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    return this.request<SendResult>(
      `/v1/messages${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`,
      { ...parsed.data, idempotency_key: message.idempotency_key ?? crypto.randomUUID() },
    );
  }

  /** An emergency alert that repeats on every device until somebody answers. */
  async alert(
    input: Omit<SendMessageInput, 'priority'> & {
      channel?: string;
      retry_seconds?: number;
      expire_seconds?: number;
    },
  ): Promise<SendResult> {
    return this.send({ retry_seconds: 60, expire_seconds: 3600, ...input, priority: 2 });
  }

  /**
   * Alert somebody and block until they acknowledge, or until it expires.
   *
   * The human-in-the-loop primitive, from the credential an agent actually
   * holds. Returns false on expiry, so a caller that ignores the result fails
   * closed rather than proceeding unapproved.
   */
  async alertAndWait(
    input: Parameters<AgentSelf['alert']>[0] & { pollSeconds?: number },
  ): Promise<{ acknowledged: boolean; receipt: string | null; result: SendResult }> {
    const { pollSeconds = 5, ...rest } = input;
    const result = await this.alert(rest);

    if (!result.receipt) return { acknowledged: false, receipt: null, result };

    const deadline = Date.now() + (rest.expire_seconds ?? 3600) * 1000;

    /**
     * The server holds the request open, so an acknowledgement comes back as
     * fast as it was made rather than on the next tick of a poll.
     * `pollSeconds` survives only as the fallback cadence for a server that
     * does not know `?wait=` yet -- an older deployment, or a self-hosted one.
     */
    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const receipt = await this.receipt(result.receipt, {
        waitSeconds: Math.min(remaining, 60),
      });
      if (receipt.acknowledged) {
        return { acknowledged: true, receipt: result.receipt, result };
      }
      // A server that ignored the wait would spin here, so this keeps the old
      // pacing for that case and costs nothing when the wait was honoured.
      if (receipt.waited_ms === undefined) {
        await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
      }
    }

    return { acknowledged: false, receipt: result.receipt, result };
  }

  /** Whether an alert you raised has been acknowledged. */
  async receipt(
    receiptId: string,
    options: { waitSeconds?: number } = {},
  ): Promise<{ acknowledged: boolean; acked_at: string | null; waited_ms?: number }> {
    const wait = options.waitSeconds ? Math.floor(options.waitSeconds) : 0;
    const suffix = wait ? `?wait=${wait}` : '';
    /**
     * The request has to outlive the hold it just asked for.
     *
     * `timeoutMs` defaults to 15s and `alertAndWait` asks the server to hold
     * for up to 60, so the client aborted its own wait, `httpRequest` treated
     * the abort as transient and retried it, and after maxAttempts the whole
     * call threw. `alertAndWait` therefore never returned "not acknowledged"
     * -- it raised a network error roughly 45 seconds in, and the CLI exited 1
     * where it documents 2. Nobody saw it because nothing tested the path
     * where a human does not answer.
     */
    return this.request(
      `/v1/receipts/${encodeURIComponent(receiptId)}${suffix}`,
      undefined,
      'GET',
      wait ? wait * 1000 + 5_000 : undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  /** Every channel this agent is reachable in. */
  async channels(): Promise<AgentChannel[]> {
    const result = await this.request<{ channels: AgentChannel[] }>('/v1/channels', undefined, 'GET');
    return result.channels;
  }

  /**
   * Make a channel — a room this agent runs and can put others in.
   *
   * It lands in the account the agent already belongs to, and carries no
   * branding: what a channel looks like on somebody's lock screen is not a thing
   * an unattended process chooses. A human can brand it later.
   */
  async createChannel(name: string, description?: string): Promise<AgentChannel & { id: string }> {
    const result = await this.request<{ channel: AgentChannel & { id: string } }>('/v1/channels', {
      name,
      ...(description ? { description } : {}),
    });
    return result.channel;
  }

  /**
   * Put another agent in a channel you made. `agent` is a recipient key or a
   * handle.
   *
   * Agents only, and the same account only. Both are refusals rather than
   * filters: pulling a person into a channel an agent named is one step from a
   * convincing notification from their bank, and reaching into another account
   * would let one customer's agent decide what another's is reachable for.
   */
  async addToChannel(channelRef: string, agent: string): Promise<{ ok: true }> {
    return this.request(`/v1/channels/${encodeURIComponent(channelRef)}/members`, { agent });
  }

  /** Take an agent out. You may always remove yourself. */
  async removeFromChannel(channelRef: string, agentKey: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/channels/${encodeURIComponent(channelRef)}/members/${encodeURIComponent(agentKey)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * Mint a way in for an agent you are about to start.
   *
   * The returned `token` is the only time the secret exists anywhere: hand it
   * to the worker as AGENTSIGNAL_JOIN_TOKEN and it can register itself on this
   * channel and do nothing else. That is why an agent is allowed to hand one
   * out — it is strictly less than the credential you are holding.
   *
   * The server clamps what it gives you. Ask for a year and you get a day; ask
   * for a million uses and you get a hundred. A supervisor asking for too much
   * gets a token that works rather than an exception at 3am.
   *
   * ```ts
   * const { token } = await self.spawnToken(channel.ref, { name: 'workers', maxUses: 5 });
   * spawnWorker({ env: { AGENTSIGNAL_JOIN_TOKEN: token } });
   * ```
   */
  async spawnToken(
    channelRef: string,
    options: { name?: string; maxUses?: number; ttlHours?: number } = {},
  ): Promise<{
    id: string;
    token: string;
    name: string;
    prefix: string;
    max_uses: number | null;
    expires_at: string;
    label_ref: string;
  }> {
    const result = await this.request<{ token: SpawnedToken }>(
      `/v1/channels/${encodeURIComponent(channelRef)}/join-tokens`,
      {
        ...(options.name ? { name: options.name } : {}),
        ...(options.maxUses ? { max_uses: options.maxUses } : {}),
        ...(options.ttlHours ? { ttl_hours: options.ttlHours } : {}),
      },
    );
    return result.token;
  }

  /** Every token this agent has handed out, so it can take them back. */
  async spawnTokens(): Promise<Omit<SpawnedToken, 'token'>[]> {
    const result = await this.request<{ tokens: Omit<SpawnedToken, 'token'>[] }>(
      '/v1/channels/join-tokens',
      undefined,
      'GET',
    );
    return result.tokens;
  }

  /** Revoke one you minted. Yours only — never a person's. */
  async revokeSpawnToken(id: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/channels/join-tokens/${encodeURIComponent(id)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * Who else is reachable, across every channel this agent is in — or inside one
   * of them if `channelRef` is given.
   *
   * Joining is what makes others visible. There is no way to enumerate a channel
   * you were never added to.
   */
  async directory(
    options: { channelRef?: string; capability?: string; agentsOnly?: boolean } = {},
  ): Promise<DirectoryEntry[]> {
    const query = new URLSearchParams();
    if (options.capability) query.set('capability', options.capability);
    if (options.agentsOnly) query.set('agents_only', 'true');
    const suffix = query.size > 0 ? `?${query}` : '';
    const path = options.channelRef
      ? `/v1/channels/${encodeURIComponent(options.channelRef)}/agents${suffix}`
      : `/v1/channels/agents${suffix}`;

    const result = await this.request<{ recipients: DirectoryEntry[] }>(path, undefined, 'GET');
    return result.recipients;
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'DELETE' = 'POST',
    timeoutMs?: number,
  ): Promise<T> {
    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: `Device ${this.credential}`,
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      // Nothing an agent does as itself is metered, so a 402 here would be a
      // surprise rather than a quota.
      on402: (message) => {
        throw new AgentSignalError('payment_required', message, 402);
      },
    });
  }
}

export type { SendMessageInput };
export { Priority } from '@agentsignal/core';
