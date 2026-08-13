import { describe, expect, it } from 'vitest';
import { sendMessageSchema, recipientKeySchema } from '../src/schemas.js';
import { isDeliverableEndpoint, endpointFault, isRedirect, assertPublicHttpsUrl } from '../src/endpoints.js';
import {
  emergencyRetryFitsExpiry,
  emergencyAlertCount,
  EMERGENCY_DEFAULT_EXPIRE_SECONDS,
} from '../src/priority.js';

/**
 * The rules, tested where they live.
 *
 * core had no tests of its own -- its risky parts were exercised only through
 * the API suite, as the API happens to use them. That is coverage of a caller,
 * not of a contract, and core is now published: these are the rules the
 * dashboard, the transports and every SDK consumer all apply from one copy, so
 * a change here is a change everywhere at once.
 */

const RECIPIENT = 'u_8fk2AbCdEfGhIjKlMnOpQr';
const SEALED = {
  ciphertext: 'AAAA',
  nonce: 'BBBB',
  keys: [{ device_id: '00000000-0000-4000-8000-000000000001', wrapped_key: 'CC', ephemeral_public_key: 'DD' }],
};

/** The message the refinements are then asked about, one field at a time. */
const base = { to: RECIPIENT, body: 'hello' };

describe('who a message is addressed to', () => {
  it('needs exactly one of to, group or broadcast', () => {
    expect(sendMessageSchema.safeParse(base).success).toBe(true);
    expect(sendMessageSchema.safeParse({ group: 'on-call', body: 'x' }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ broadcast: true, body: 'x' }).success).toBe(true);

    // None, and two, are both refused. A send with no target used to be a
    // 500 from the database rather than a 400 from here.
    expect(sendMessageSchema.safeParse({ body: 'x' }).success).toBe(false);
    expect(
      sendMessageSchema.safeParse({ to: RECIPIENT, group: 'on-call', body: 'x' }).success,
    ).toBe(false);
  });

  it('insists a recipient key looks like one', () => {
    expect(recipientKeySchema.safeParse(RECIPIENT).success).toBe(true);
    expect(recipientKeySchema.safeParse('u_short').success).toBe(false);
    expect(recipientKeySchema.safeParse('8fk2AbCdEfGhIjKlMnOpQr').success).toBe(false);
  });
});

describe('body and ciphertext', () => {
  it('takes one of body or sealed, never both and never neither', () => {
    expect(sendMessageSchema.safeParse({ to: RECIPIENT, sealed: SEALED }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ to: RECIPIENT }).success).toBe(false);
    expect(
      sendMessageSchema.safeParse({ to: RECIPIENT, body: 'x', sealed: SEALED }).success,
    ).toBe(false);
  });

  it('refuses to seal a broadcast, because a group has no keys to seal to', () => {
    expect(sendMessageSchema.safeParse({ broadcast: true, sealed: SEALED }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ group: 'on-call', sealed: SEALED }).success).toBe(false);
  });

  /**
   * The options ride in the push payload and on the buttons, in the clear. A
   * sealed body next to a visible question promises a privacy the message does
   * not have, so the combination is refused rather than half-honoured.
   */
  it('refuses to seal a question', () => {
    expect(
      sendMessageSchema.safeParse({ to: RECIPIENT, sealed: SEALED, options: ['Yes', 'No'] }).success,
    ).toBe(false);
  });

  it('allows at most three options', () => {
    expect(sendMessageSchema.safeParse({ ...base, options: ['a', 'b', 'c'] }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ ...base, options: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });

  it('will not render as html and monospace at once', () => {
    expect(sendMessageSchema.safeParse({ ...base, html: true, monospace: true }).success).toBe(false);
  });
});

describe('an emergency that would never repeat', () => {
  /**
   * A retry longer than its own expiry fires once and never again, which is
   * the opposite of what priority 2 is for. The rule lives in core because the
   * dashboard applies it too -- its schedule route stores the payload verbatim
   * and never reaches the schema.
   */
  it('is refused by the schema', () => {
    expect(
      sendMessageSchema.safeParse({ ...base, priority: 2, retry_seconds: 60, expire_seconds: 3600 }).success,
    ).toBe(true);
    expect(
      sendMessageSchema.safeParse({ ...base, priority: 2, retry_seconds: 600, expire_seconds: 120 }).success,
    ).toBe(false);
  });

  it('compares against the defaults when a field is omitted', () => {
    expect(emergencyRetryFitsExpiry(60, 3600)).toBe(true);
    // Nothing supplied is the default pair, which fits.
    expect(emergencyRetryFitsExpiry(undefined, undefined)).toBe(true);
    // A retry beyond the default expiry, with no expiry given, does not.
    expect(emergencyRetryFitsExpiry(EMERGENCY_DEFAULT_EXPIRE_SECONDS + 1, undefined)).toBe(false);
  });

  it('counts the alerts somebody would actually receive', () => {
    expect(emergencyAlertCount(60, 3600)).toBe(60);
    expect(emergencyAlertCount(30, 100)).toBe(4); // rounds up: the tail still fires
    expect(emergencyAlertCount(undefined, undefined)).toBe(60);
  });
});

describe('the endpoints we are willing to fetch', () => {
  /**
   * This is the SSRF boundary. A customer supplies the URL and this service
   * then fetches it, so the list of refusals is the security property -- and
   * `.url()` alone accepted `http://169.254.169.254/`, the cloud metadata
   * address, along with every scheme a URL parser knows.
   */
  it('accepts a plain public https endpoint', () => {
    expect(isDeliverableEndpoint('https://example.com/hook')).toBe(true);
    expect(isDeliverableEndpoint('https://example.com:443/hook')).toBe(true);
  });

  it.each([
    ['http, not https', 'http://example.com/hook'],
    ['a scheme that is not http at all', 'javascript:alert(1)'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['an https IP literal', 'https://169.254.169.254/'],
    ['loopback', 'https://127.0.0.1/hook'],
    ['a private range', 'https://10.0.0.1/hook'],
    ['an internal hostname', 'https://localhost/hook'],
    ['credentials in the url', 'https://user:pass@example.com/hook'],
    ['a port that is not 443', 'https://example.com:8080/hook'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_why, url) => {
    expect(isDeliverableEndpoint(url)).toBe(false);
    // Every refusal can say why, so a form can tell somebody what to change.
    expect(endpointFault(url)).toBeTruthy();
    expect(() => assertPublicHttpsUrl(url)).toThrow();
  });

  it('has nothing to complain about for a good endpoint', () => {
    expect(endpointFault('https://example.com/hook')).toBeNull();
  });

  /**
   * workerd rejects `redirect: 'error'` when the Request is constructed, so
   * every outbound fetch that used it threw before opening a socket. The
   * replacement is `manual` plus this check, which makes a 3xx a refusal.
   */
  it('treats every 3xx as a redirect and nothing else', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(isRedirect(status)).toBe(true);
    for (const status of [200, 201, 204, 400, 404, 500]) expect(isRedirect(status)).toBe(false);
  });
});
