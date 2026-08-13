/**
 * Which URLs we are willing to make a request to.
 *
 * Every outbound HTTP call this product makes goes to an address a customer
 * typed: a webhook device's endpoint, and the callback an emergency fires on
 * acknowledgement. That is server-side request forgery by construction, and
 * this module is the whole defence.
 *
 * It lives in the shared package rather than beside one of its callers because
 * it has to run in three places -- the send schema, the transport that leaves
 * the building, and the dashboard field where someone types the URL -- and a
 * rule enforced in two of those is a rule with a way around it. It imports
 * nothing, so `@agentsignal/core/endpoints` is reachable from a browser bundle
 * without dragging zod along.
 */

/**
 * Reject anything that is not a public HTTPS endpoint.
 *
 * Deliberately a hostname allowlist by shape rather than a blocklist of known
 * metadata addresses: the interesting targets are the ones nobody has thought
 * of yet, and a blocklist is a list of the ones somebody already has.
 *
 * DNS is the hole this cannot close on its own -- a name that resolves to a
 * private address passes every check here. Cloudflare Workers do not reach
 * RFC1918 space or link-local from the public fetch path, which is what closes
 * it in practice; on any other runtime this would need resolution pinning too,
 * and that is worth knowing before this code is lifted somewhere else.
 *
 * Callers must also refuse redirects. Everything checked here describes the URL
 * we were given, and a 302 is how a receiver hands us a different one after we
 * have finished looking at it.
 *
 * Use `redirect: 'manual'` and treat any 3xx as a refusal -- see
 * `isRedirect` below. NOT `redirect: 'error'`: workerd rejects that value when
 * the Request is constructed, so the fetch throws before a socket is opened
 * and every delivery fails in a way that reads exactly like an unreachable
 * receiver. That shipped, and it is why this is written down here rather than
 * left to each caller to remember.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('endpoint must be a URL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('endpoint must be https');
  }
  if (url.username || url.password) {
    throw new Error('endpoint must not carry credentials');
  }
  if (url.port && url.port !== '443') {
    throw new Error('endpoint must be on the default https port');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  // A bare name with no dot is something on an internal network by definition.
  if (!host.includes('.')) {
    throw new Error('endpoint must be a public hostname');
  }

  const RESERVED = ['localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
  if (RESERVED.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix))) {
    throw new Error('endpoint must be a public hostname');
  }

  // IP literals are refused outright, in either family. A legitimate webhook
  // has a name; an address is how the private ranges get reached.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(url.host)) {
    throw new Error('endpoint must be a hostname, not an IP address');
  }

  return url;
}

/**
 * The redirect a caller must refuse rather than follow.
 *
 * With `redirect: 'manual'` the 3xx comes back as an ordinary response instead
 * of being chased, which is what makes it refusable: following it would reach
 * an address `assertPublicHttpsUrl` never saw and never approved.
 */
export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** True if this URL is one we are willing to hold. */
export function isDeliverableEndpoint(raw: string): boolean {
  try {
    assertPublicHttpsUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** Why this URL was refused, in words someone typing it can act on. */
export function endpointFault(raw: string): string | null {
  try {
    assertPublicHttpsUrl(raw);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'endpoint is not usable';
  }
}
