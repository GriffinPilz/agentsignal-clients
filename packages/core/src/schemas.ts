import { z } from 'zod';
import { isDeliverableEndpoint } from './endpoints.js';
import {
  emergencyRetryFitsExpiry,
  EMERGENCY_MAX_EXPIRE_SECONDS,
  EMERGENCY_MIN_RETRY_SECONDS,
} from './priority.js';

/** Recipient keys are what a caller addresses: `u_` plus 22 base62 chars. */
export const recipientKeySchema = z
  .string()
  .regex(/^u_[0-9A-Za-z]{22}$/, 'must look like u_XXXXXXXXXXXXXXXXXXXXXX');

export const uuidSchema = z.string().uuid();

/** Either a recipient key or a raw id -- the API accepts both. */
const targetRefSchema = z.union([recipientKeySchema, uuidSchema]);

/**
 * The sealed form of a message body, as `seal()` produces it.
 *
 * Declared here because zod strips what it has not been told about: an
 * encrypted send that omitted this from the schema arrived at the database
 * with the ciphertext quietly removed, and the message was rejected for
 * having no body at all.
 */
const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

export const sealedContentSchema = z.object({
  ciphertext: b64.max(16384),
  nonce: b64.max(32),
  keys: z
    .array(
      z.object({
        device_id: uuidSchema,
        wrapped_key: b64.max(256),
        ephemeral_public_key: b64.max(64),
      }),
    )
    .min(1)
    .max(64),
});

export const sendMessageSchema = z
  .object({
    // Exactly one of these three selects who gets the notification.
    to: targetRefSchema.optional(),
    group: z.string().min(1).max(64).optional(),
    broadcast: z.literal(true).optional(),

    title: z.string().max(250).optional(),
    /**
     * Optional only because an encrypted send has no plaintext to put here.
     * Exactly one of `body` and `sealed` is required -- see the refinement
     * below, which is what keeps "no body" from meaning "empty message".
     */
    body: z.string().min(1).max(4096).optional(),
    /**
     * Ciphertext plus one wrapped key per device, when the caller sealed it
     * themselves. The plaintext never reaches us.
     */
    sealed: sealedContentSchema.optional(),
    /**
     * Turns a message into a question. Up to three answers a recipient can
     * pick from, in the order they will be shown.
     *
     * Three because that is what fits on a notification and in a row of
     * buttons; more than that is a form. Forty characters because an option
     * nobody can read is not an option.
     */
    options: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(3)
      .optional(),
    priority: z.number().int().min(-2).max(2).default(0),
    sound: z.string().max(64).optional(),
    url: z.string().url().max(512).optional(),
    url_title: z.string().max(100).optional(),
    ttl_seconds: z.number().int().positive().max(2_592_000).optional(),
    html: z.boolean().default(false),
    monospace: z.boolean().default(false),
    tags: z.array(z.string().max(64)).max(16).optional(),
    /** Arbitrary structured payload delivered to the client untouched. */
    data: z.record(z.string(), z.unknown()).default({}),
    /** Replaces an earlier undelivered message with the same key. */
    collapse_key: z.string().max(64).optional(),

    // Emergency priority only.
    retry_seconds: z
      .number()
      .int()
      .min(EMERGENCY_MIN_RETRY_SECONDS)
      .max(EMERGENCY_MAX_EXPIRE_SECONDS)
      .optional(),
    expire_seconds: z
      .number()
      .int()
      .min(EMERGENCY_MIN_RETRY_SECONDS)
      .max(EMERGENCY_MAX_EXPIRE_SECONDS)
      .optional(),
    /**
     * Where to POST when someone acknowledges.
     *
     * Held to the same standard as a webhook device's endpoint, because it is
     * the same thing: a URL a customer supplies and this service then fetches.
     * `.url()` alone accepted `http://169.254.169.254/`, and every scheme the
     * URL parser knows including `javascript:` -- which then failed inside
     * `fireAckCallback`'s catch, indistinguishable from a healthy endpoint
     * nobody called.
     */
    callback_url: z
      .string()
      .max(2048)
      .refine(isDeliverableEndpoint, {
        message:
          'callback_url must be a public https URL: no IP addresses, no internal hostnames, no credentials, port 443 only',
      })
      .optional(),

    idempotency_key: z.string().min(1).max(255).optional(),
  })
  .refine(
    (v) => [v.to, v.group, v.broadcast].filter((x) => x !== undefined).length === 1,
    { message: 'specify exactly one of `to`, `group`, or `broadcast`' },
  )
  .refine((v) => (v.body === undefined) !== (v.sealed === undefined), {
    message: 'provide either `body` or `sealed`, not both and not neither',
    path: ['body'],
  })
  // Sealing addresses one person, because every device needs its own wrapped
  // key and a group is resolved server-side, after the sender has already had
  // to decide what to encrypt to.
  .refine((v) => v.sealed === undefined || v.to !== undefined, {
    message: 'an encrypted message must be addressed `to` one recipient',
    path: ['sealed'],
  })
  // Options ride in the push payload and on the buttons. Sealing the body
  // while sending the question in the clear would promise a privacy the
  // message does not have, so the combination is refused rather than
  // half-honoured.
  .refine((v) => v.options === undefined || v.sealed === undefined, {
    message:
      'an encrypted message cannot carry options: the options travel in the clear, so only the answer would be private',
    path: ['options'],
  })
  .refine((v) => !(v.html && v.monospace), {
    message: '`html` and `monospace` are mutually exclusive',
    path: ['monospace'],
  })
  /**
   * A repeat that outlives its own expiry never repeats.
   *
   * The rule lives in `emergencyRetryFitsExpiry` rather than here, because the
   * dashboard has to apply the same one: its schedule route stores `payload`
   * verbatim without ever reaching this schema, so a form that reimplemented
   * the comparison would be the second of two copies and the one nobody
   * updates.
   */
  .refine((v) => v.priority !== 2 || emergencyRetryFitsExpiry(v.retry_seconds, v.expire_seconds), {
    message:
      '`retry_seconds` must not exceed `expire_seconds` (which defaults to 3600)',
    path: ['retry_seconds'],
  });

export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type SendMessage = z.output<typeof sendMessageSchema>;

export const devicePlatformSchema = z.enum([
  'ios',
  'ipados',
  'macos',
  'android',
  'linux',
  'windows',
  'web',
  'agent',
]);

export const deviceTransportSchema = z.enum([
  'apns',
  'fcm',
  'webpush',
  'websocket',
  'webhook',
  /**
   * A device with no address of its own.
   *
   * Nothing is pushed to it: the delivery row *is* the delivery, and the
   * holder reads its own inbox when it next asks. This is what an agent almost
   * always is -- a process in a container that nothing outside can reach.
   */
  'inbox',
  /**
   * An agent on the Pilot overlay, addressed as `0:0000.0000.037D`.
   *
   * Unlike every other transport here, we cannot reach it from this runtime:
   * Pilot is UDP with NAT hole-punching, and Workers have neither UDP nor
   * inbound connections. The send goes through a bridge that holds a socket.
   */
  'pilot',
]);

export const registerDeviceSchema = z.object({
  /** Client-generated and stable across push-token rotation. */
  install_id: uuidSchema,
  platform: devicePlatformSchema,
  transport: deviceTransportSchema,
  /** APNs/FCM token, webpush endpoint, or webhook URL. */
  token: z.string().min(1).max(2048).optional(),
  keys: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1).max(120).default('Device'),
  model: z.string().max(120).optional(),
  app_version: z.string().max(40).optional(),
  /**
   * The public half of this device's encryption keypair, base64.
   *
   * Declared here or it does not exist: zod strips keys it has not been told
   * about, silently and by design. The client sent this from the day
   * encrypted messages shipped, it was dropped at this boundary, and the
   * symptom was that no device ever published a key -- so every encrypted
   * send was refused with "nobody has an encryption key" and the cause was
   * two files away.
   *
   * X25519, so exactly 32 bytes: 43 base64 characters and one '='. Pinning
   * the length means a truncated or wrong-curve key is refused at the edge
   * rather than stored and discovered later by a message that will not open.
   */
  enc_public_key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be a base64 X25519 public key (32 bytes)')
    .optional(),
  /**
   * SHA-256 of a secret the client generated and kept.
   *
   * Optional because it is the newer of two ways to pair. Originally the
   * Worker minted the device secret and handed it back, which means the
   * server saw it once -- and there is no reason it ever had to. A client
   * that sends this keeps the only copy; one that omits it gets the old
   * behaviour, which is what every build already in the wild does.
   *
   * Hex rather than base64 because that is what `register_device` decodes and
   * what `requireDevice` compares against, and pinning the length here means
   * a truncated digest is refused at the edge rather than stored as a
   * credential nothing can ever match.
   */
  secret_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a hex SHA-256 digest')
    .optional(),
});

export type RegisterDeviceInput = z.input<typeof registerDeviceSchema>;

export const claimEnrollmentSchema = z.object({
  /** Eight Crockford base32 characters, case-insensitive on the wire. */
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase().replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/, 'invalid enrollment code')),
  device: registerDeviceSchema,
});

/** One answer, by position in the options array. */
export const respondSchema = z.object({
  option_index: z.number().int().min(0).max(2),
});

export const ackReceiptSchema = z.object({
  receipt_id: z.string().regex(/^r_[0-9A-Za-z]{22}$/),
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * The message a schedule sends.
 *
 * The send schema minus `idempotency_key`: a scheduled message gets one minted
 * per run, derived from the slot, so the same slot can never send twice. Taking
 * one from the caller would mean every run after the first was suppressed as a
 * replay -- a schedule that fires exactly once and then looks like it is
 * working.
 */
export const schedulePayloadSchema = sendMessageSchema.refine(
  (v) => v.body !== undefined && v.sealed === undefined,
  {
    message:
      'a scheduled message cannot be encrypted: sealing needs the recipient device keys as they are at send time, not as they were when the schedule was written',
    path: ['body'],
  },
);

export const scheduleFreqSchema = z.enum([
  'hourly',
  'daily',
  'weekly',
  'monthly',
]);

/**
 * Five fields, the usual ones. Checked properly in the database, where the
 * same parser decides both whether it is valid and when it next fires -- two
 * implementations of cron would eventually disagree, and the symptom would be
 * a message arriving on a day nobody chose.
 */
const cronSchema = z
  .string()
  .trim()
  .regex(
    /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/,
    'a cron expression has five fields: minute hour day-of-month month day-of-week',
  );

/**
 * A wall clock with no offset: `2026-08-10T09:00`.
 *
 * Read in the schedule's own `timezone`, by Postgres, against the IANA
 * database. This is what a date field in a browser can actually produce, and
 * accepting it is what stops a caller from having to do offset arithmetic --
 * the dashboard used to append `Z`, so 09:00 picked in New York was scheduled
 * for 04:00 local.
 */
const localWallClockSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
    'use YYYY-MM-DDTHH:MM, with no timezone offset — it is read in `timezone`',
  );

const scheduleRuleFields = {
  /** IANA name. Required, because "09:00" means nothing without one. */
  timezone: z.string().min(1).max(64),
  run_at: z.string().datetime({ offset: true }).optional(),
  run_at_local: localWallClockSchema.optional(),
  freq: scheduleFreqSchema.optional(),
  every_n: z.number().int().min(1).max(999).optional(),
  /** Local wall clock, `HH:MM`. */
  at_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM')
    .optional(),
  at_minute: z.number().int().min(0).max(59).optional(),
  /** 0 is Sunday, matching both Postgres and cron. */
  days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  cron: cronSchema.optional(),
  starts_at: z.string().datetime({ offset: true }).optional(),
  starts_at_local: localWallClockSchema.optional(),
  ends_at: z.string().datetime({ offset: true }).optional(),
  ends_at_local: localWallClockSchema.optional(),
  max_runs: z.number().int().positive().max(100_000).optional(),
};

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(['once', 'recurring']),
    payload: schedulePayloadSchema,
    ...scheduleRuleFields,
  })
  .refine(
    (v) =>
      v.kind !== 'once' || v.run_at !== undefined || v.run_at_local !== undefined,
    {
      message: 'a one-off schedule needs `run_at` or `run_at_local`',
      path: ['run_at'],
    },
  )
  .refine(
    (v) =>
      v.kind !== 'recurring' ||
      (v.freq === undefined) !== (v.cron === undefined),
    {
      message: 'a recurring schedule needs either `freq` or `cron`, not both',
      path: ['freq'],
    },
  )
  .refine((v) => v.freq !== 'weekly' || v.days_of_week !== undefined, {
    message: 'a weekly schedule needs `days_of_week`',
    path: ['days_of_week'],
  })
  .refine((v) => v.freq !== 'monthly' || v.day_of_month !== undefined, {
    message: 'a monthly schedule needs `day_of_month`',
    path: ['day_of_month'],
  });

/**
 * Editing takes nulls where creating does not.
 *
 * Clearing a field is how someone moves a schedule between the two ways of
 * saying when: switching to `cron` means `freq` has to go, and the database
 * rejects a schedule carrying both. Without nullable fields there is no way to
 * express that, and the only route from "every weekday" to a cron expression
 * would be deleting the schedule and building it again.
 */
export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    payload: schedulePayloadSchema.optional(),
    enabled: z.boolean().optional(),
    timezone: scheduleRuleFields.timezone.optional(),
    run_at: scheduleRuleFields.run_at.nullish(),
    run_at_local: scheduleRuleFields.run_at_local.nullish(),
    freq: scheduleFreqSchema.nullish(),
    every_n: scheduleRuleFields.every_n,
    at_time: scheduleRuleFields.at_time.nullish(),
    at_minute: scheduleRuleFields.at_minute.nullish(),
    days_of_week: scheduleRuleFields.days_of_week.nullish(),
    day_of_month: scheduleRuleFields.day_of_month.nullish(),
    cron: cronSchema.nullish(),
    starts_at: scheduleRuleFields.starts_at.nullish(),
    starts_at_local: scheduleRuleFields.starts_at_local.nullish(),
    ends_at: scheduleRuleFields.ends_at.nullish(),
    ends_at_local: scheduleRuleFields.ends_at_local.nullish(),
    max_runs: scheduleRuleFields.max_runs.nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'nothing to update',
  });

export type CreateScheduleInput = z.input<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.input<typeof updateScheduleSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * What an agent says about itself when it joins.
 *
 * `handle` is the identity and everything else is description. Registering the
 * same handle twice is the same agent coming back, not a second one -- which
 * is the difference between a directory and a pile.
 */
export const registerAgentSchema = z.object({
  /** Lowercase, dash-separated, stable across restarts. */
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
      'a handle is 3-40 characters, lowercase letters, digits and dashes',
    ),
  /** Shown in the directory. Defaults to the handle. */
  name: z.string().trim().min(1).max(120).optional(),
  /** One line: what this agent does. What another agent reads when choosing. */
  description: z.string().trim().min(1).max(280).optional(),
  /** Lowercase tags the directory can be filtered by. */
  capabilities: z
    .array(z.string().trim().toLowerCase().min(1).max(40))
    .max(20)
    .optional(),
  /**
   * This running copy. Persist it and a restart rejoins as the same instance;
   * omit it and each boot is a new one, which is fine for something
   * short-lived but leaves stale devices behind for something that is not.
   */
  instance_id: z.string().uuid().optional(),
  instance_name: z.string().trim().min(1).max(120).optional(),
  /**
   * Where to push, if this agent is reachable. Omit it and the agent reads its
   * own inbox instead, which needs no inbound address and works from behind
   * anything -- the right default for almost every agent.
   */
  endpoint: z.string().url().max(2048).optional(),
});

export type RegisterAgentInput = z.input<typeof registerAgentSchema>;
