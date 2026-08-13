/**
 * Priority levels, deliberately identical to Pushover's so that an existing
 * integration can be repointed at AgentSignal without touching its payloads.
 */
export const Priority = {
  /** No alert at all; badge only. */
  Lowest: -2,
  /** Alert with no sound or vibration. */
  Low: -1,
  /** Normal alert, subject to the device's own settings. */
  Normal: 0,
  /**
   * Delivered at once and marked time-sensitive.
   *
   * Not "bypasses quiet hours", which is what this said and what three other
   * places copied from it. Piercing a Focus needs Apple's Time Sensitive
   * Notifications entitlement, which no build of this app has ever carried, so
   * the level is marked urgent and still waits behind Do Not Disturb.
   */
  High: 1,
  /** Repeats until a human acknowledges it. */
  Emergency: 2,
} as const;

export type PriorityValue = (typeof Priority)[keyof typeof Priority];

/**
 * Defaults applied when an emergency send omits its schedule.
 *
 * These are `ingest_into_project`'s coalesce values, not merely ours: a send
 * that names neither gets exactly these, so anything reasoning about what an
 * emergency will *do* has to fill the gaps with them rather than treat an
 * absent field as absent.
 *
 * This module is reachable as `@agentsignal/core/priority` and imports
 * nothing, so the dashboard can share these numbers without pulling zod and
 * every schema into a browser bundle for the sake of four integers.
 */
export const EMERGENCY_DEFAULT_RETRY_SECONDS = 60;
export const EMERGENCY_DEFAULT_EXPIRE_SECONDS = 3600;

/** Apple refuses a retry interval under 30s, and we cap total nagging at 3h. */
export const EMERGENCY_MIN_RETRY_SECONDS = 30;
export const EMERGENCY_MAX_EXPIRE_SECONDS = 10800;

/**
 * Will this repeat interval fit inside the expiry it will actually be given?
 *
 * Takes what the caller named, not what is stored, and fills each gap with the
 * default that will be applied -- because the two default independently. A
 * check that compares only the fields it was handed passes the single
 * combination that cannot work: `{retry_seconds: 7200}` alone, against an
 * expiry that defaults to an hour, gives up long before it is due to repeat.
 *
 * Equal is allowed. It repeats zero times, which is a strange thing to ask for
 * and an honest one -- the alert still fires, and it still needs acknowledging.
 */
export function emergencyRetryFitsExpiry(
  retrySeconds?: number,
  expireSeconds?: number,
): boolean {
  return (
    (retrySeconds ?? EMERGENCY_DEFAULT_RETRY_SECONDS) <=
    (expireSeconds ?? EMERGENCY_DEFAULT_EXPIRE_SECONDS)
  );
}

/**
 * How many times a device goes off, at most.
 *
 * The send itself is the first alert; `EmergencyReceipt` re-alerts at every
 * multiple of the retry that still falls before the expiry, so the total is
 * `ceil(expire / retry)`. An acknowledgement stops it earlier, which is the
 * whole point -- this is the ceiling, not a prediction.
 *
 * Worth stating out loud wherever someone picks the two numbers: thirty
 * seconds for three hours reads as two harmless fields and is three hundred
 * and sixty alerts.
 */
export function emergencyAlertCount(
  retrySeconds?: number,
  expireSeconds?: number,
): number {
  const retry = retrySeconds ?? EMERGENCY_DEFAULT_RETRY_SECONDS;
  const expire = expireSeconds ?? EMERGENCY_DEFAULT_EXPIRE_SECONDS;
  if (retry <= 0) return 0;
  return Math.ceil(expire / retry);
}
