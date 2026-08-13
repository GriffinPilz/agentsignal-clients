#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  AgentSelf,
  AgentSignal,
  AgentSignalError,
  AgentSignalX402,
  PaymentRequiredError,
  QuotaExceededError,
  DEFAULT_BASE_URL,
} from '@agentsignal/sdk';

/**
 * AgentSignal as an MCP server.
 *
 * The interesting keyed tool is `ask_human`: an agent that needs sign-off can
 * call it and block until a person acknowledges on their phone, which turns
 * "notify someone" from fire-and-forget into control flow an agent can wait on.
 *
 * TWO WAYS IN, AND IT NO LONGER INSISTS ON ONE
 *
 * This used to exit at startup without an `AGENTSIGNAL_API_KEY`, which meant
 * an agent that had never heard of us could not take a single step -- it had
 * to go and find a human with a dashboard first. That is exactly the cold
 * start pay-as-you-go exists to remove, so the server now boots with either
 * credential, or with neither.
 *
 * With a key: everything, billed to that account's plan.
 * With a credit token, or nothing at all: `open_credit` gets a free block and
 * `notify_paid` spends it. No account, no dashboard, no human.
 *
 * Tools are registered conditionally rather than always-registered-and-then-
 * refusing. A tool an agent can see is a tool it will try, and "you cannot use
 * this" spent as a turn is worse than the tool not being there.
 */

const apiKey = process.env.AGENTSIGNAL_API_KEY;
const baseUrl = process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL;

const client = apiKey ? new AgentSignal({ apiKey, baseUrl }) : null;

/**
 * The pay-as-you-go client, always present.
 *
 * Holds any token it is given or mints, in memory. A stdio server dies with
 * its process, so a token minted here is gone on restart unless the agent
 * saves it -- which is why every response that carries one says so.
 */
const payClient = new AgentSignalX402({
  baseUrl,
  ...(process.env.AGENTSIGNAL_CREDIT ? { credit: process.env.AGENTSIGNAL_CREDIT } : {}),
});

/** Turn an SDK error into something an agent can reason about and act on. */
function toToolError(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  let text: string;

  if (error instanceof PaymentRequiredError) {
    // Deliberately different advice from a quota error below. This one is
    // recoverable and the agent may be able to act on it.
    text =
      error.reason === 'free_allowance_exhausted'
        ? `That recipient has taken all the free deliveries it accepts this month. This is their limit, not yours — your credit still works for other recipients. To reach this one, a pack has to be bought with a wallet. ${error.message}`
        : `Payment required: ${error.message}${
            error.packs.length > 0
              ? ` On sale: ${error.packs.map((p) => `${p.code} → ${p.deliveries} deliveries`).join(', ')}.`
              : ''
          } Buying needs a wallet that can sign an x402 payment; this server cannot do that for you.`;
  } else if (error instanceof QuotaExceededError) {
    text = `Quota exhausted: ${error.message} Notifications will not be delivered until the plan is upgraded or the month rolls over. Do not retry.`;
  } else if (error instanceof AgentSignalError) {
    text =
      error.code === 'recipient_not_found'
        ? // Which advice is useful depends on what this server can actually
          // do. Telling an agent running on credit alone to call `list_people`
          // sends it after a tool that was never registered — a dead end that
          // costs it a turn and teaches it nothing.
          client
          ? 'No such recipient. Call list_people to see who can be notified.'
          : 'No such recipient, or that channel does not accept pay-as-you-go sends. Recipient keys look like "u_…" and are given to you by whoever you are trying to reach; there is no directory to browse without an API key.'
        : error.code === 'missing_credit'
          ? `No credit token. Call open_credit first — it needs no account, no wallet and no payment.`
          : `${error.code}: ${error.message}`;
  } else if (error instanceof Error) {
    text = error.message;
  } else {
    text = String(error);
  }

  return { content: [{ type: 'text', text }], isError: true };
}

const server = new McpServer({ name: 'agentsignal', version: '0.1.0' });

/**
 * Register a tool that needs an API key.
 *
 * A no-op when there is no key, so an agent running on credit alone is never
 * shown a tool it cannot use. Being offered one and burning a turn to be told
 * "not available" is worse than it simply not being there.
 */
const registerKeyed: typeof server.registerTool = client
  ? server.registerTool.bind(server)
  : (((..._args: unknown[]) => undefined) as never);

/** The keyed client, inside a handler only reachable when one exists. */
function keyed(): AgentSignal {
  if (!client) {
    throw new AgentSignalError(
      'no_api_key',
      'This tool needs an AgentSignal API key. Set AGENTSIGNAL_API_KEY, or use open_credit and notify_paid, which need no account.',
    );
  }
  return client;
}

function keyedKey(): string {
  if (!apiKey) throw new AgentSignalError('no_api_key', 'This tool needs an AgentSignal API key.');
  return apiKey;
}

// ---------------------------------------------------------------------------
// list_people
// ---------------------------------------------------------------------------

registerKeyed(
  'list_people',
  {
    title: 'List notifiable people',
    description:
      'List the people this AgentSignal channel can notify, with how many devices each has paired. Call this before notifying if you do not already have a recipient key. Someone with zero devices cannot be reached.',
    inputSchema: {},
  },
  async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/recipients`, {
        headers: { Authorization: `Bearer ${keyedKey()}` },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new AgentSignalError(
          'list_failed',
          payload?.error?.message ?? `Request failed (${response.status}).`,
        );
      }

      const data = (await response.json()) as {
        channel: { name: string; is_sandbox: boolean };
        recipients: { key: string; name: string; devices: number; reachable: boolean }[];
      };

      if (data.recipients.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Channel "${data.channel.name}" has no people yet. Add someone in the AgentSignal dashboard, then pair their device.`,
            },
          ],
        };
      }

      const lines = data.recipients.map(
        (person) =>
          `${person.key}  ${person.name}${
            person.reachable
              ? ` (${person.devices} device${person.devices === 1 ? '' : 's'})`
              : '  [NOT REACHABLE — no paired devices]'
          }`,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Channel: ${data.channel.name}${data.channel.is_sandbox ? ' (sandbox — history here is swept on a schedule, but sends still count against the plan)' : ''}\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

registerKeyed(
  'notify',
  {
    title: 'Notify a human',
    description:
      "Send a push notification to a person's phone, tablet, and computer. Use this to tell someone that something finished, needs attention, or went wrong. Fire and forget — it does not wait for a reply. For anything that needs a human decision before you continue, use ask_human instead.",
    inputSchema: {
      to: z
        .string()
        .describe('Recipient key, like u_8fk2… . Call list_people if you do not have one.'),
      body: z.string().max(4096).describe('The message. Keep it short and specific.'),
      title: z
        .string()
        .max(250)
        .optional()
        .describe('Optional title. Defaults to the channel name.'),
      priority: z
        .enum(['lowest', 'low', 'normal', 'high'])
        .default('normal')
        .describe(
          "How loud. 'high' is delivered at once and marked time-sensitive, and should be reserved for things that genuinely cannot wait until morning. It does NOT get past Do Not Disturb — nothing here does yet — so do not choose it believing it will wake someone.",
        ),
      url: z.string().url().optional().describe('A link shown under the message.'),
      url_title: z.string().max(100).optional(),
      tags: z.array(z.string()).max(16).optional(),
    },
  },
  async ({ to, body, title, priority, url, url_title, tags }) => {
    try {
      const levels = { lowest: -2, low: -1, normal: 0, high: 1 } as const;

      const result = await keyed().send({
        to,
        body,
        priority: levels[priority],
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(url_title ? { url_title } : {}),
        ...(tags ? { tags } : {}),
      });

      if (result.deliveries.total === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Nobody was reached: that person has no paired devices. The message was recorded but nothing was delivered.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: result.replayed
              ? `Already sent — this was an idempotent replay, so nobody was notified twice.`
              : `Delivered to ${result.deliveries.sent} of ${result.deliveries.total} devices${
                  result.deliveries.queued > 0
                    ? `, ${result.deliveries.queued} queued for retry`
                    : ''
                }.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// ask_human
// ---------------------------------------------------------------------------

registerKeyed(
  'ask_human',
  {
    title: 'Ask a human and wait',
    description:
      "Alert a person and BLOCK until they acknowledge on their device. The alert repeats on every device they own until someone responds, so use it only when you genuinely need a human before continuing — approval to proceed, a decision you cannot make, or something breaking that needs eyes now. Returns whether they acknowledged. If it expires unacknowledged, treat that as 'no' and do not proceed.",
    inputSchema: {
      to: z.string().describe('Recipient key, like u_8fk2… .'),
      body: z
        .string()
        .max(4096)
        .describe(
          'What you need from them. Be specific about what you are about to do, since they are deciding based on this alone.',
        ),
      title: z.string().max(250).optional(),
      wait_seconds: z
        .number()
        .int()
        .min(30)
        .max(10800)
        .default(600)
        .describe('How long to wait before giving up. Defaults to 10 minutes.'),
      retry_seconds: z
        .number()
        .int()
        .min(30)
        .max(10800)
        .default(60)
        .describe('Seconds between re-alerts while waiting.'),
    },
  },
  async ({ to, body, title, wait_seconds, retry_seconds }) => {
    try {
      const outcome = await keyed().alertAndWait({
        to,
        body,
        expire_seconds: wait_seconds,
        retry_seconds,
        ...(title ? { title } : {}),
      });

      if (outcome.result.deliveries.total === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Nobody was reached: that person has no paired devices. No human saw this — do not treat it as approval.',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: outcome.acknowledged
              ? 'Acknowledged by a human. You may proceed.'
              : `No acknowledgement within ${wait_seconds}s. Treat this as "no" — do not proceed on the assumption they agreed.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// register_self
// ---------------------------------------------------------------------------

registerKeyed(
  'register_self',
  {
    title: 'Join this channel as an addressable agent',
    description:
      'Register yourself so other agents and people can send you messages. Pick a stable handle and reuse it every time you start — registering the same handle again is you coming back, not a second copy of you. Describe what you do and list your capabilities: that is what another agent reads when deciding whether to hand work to you. Returns a device secret you can read your own inbox with; it is shown once.',
    inputSchema: {
      handle: z
        .string()
        .describe(
          'Stable id for you, lowercase with dashes, 3-40 characters. Use the same one on every start, e.g. "deploy-bot".',
        ),
      description: z
        .string()
        .max(280)
        .optional()
        .describe(
          'One line on what you do. This is what another agent reads when choosing between you and someone else, so be concrete: "ships and rolls back releases" beats "handles deployments".',
        ),
      capabilities: z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          'Lowercase tags others can filter on, e.g. ["deploy", "rollback"]. Keep them the words someone would actually search for.',
        ),
      name: z.string().max(120).optional().describe('Display name. Defaults to the handle.'),
      instance_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'This running copy. Persist it and a restart rejoins as the same instance; omit it and each start is a new one.',
        ),
    },
  },
  async ({ handle, description, capabilities, name, instance_id }) => {
    try {
      const result = await keyed().register({
        handle,
        ...(description ? { description } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(name ? { name } : {}),
        ...(instance_id ? { instance_id } : {}),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              result.created
                ? `Registered as ${result.agent.handle}.`
                : `Rejoined as ${result.agent.handle} — this handle was already registered, so you are the same agent as before.`,
              `Others address you as ${result.agent.key}.`,
              `Read your inbox with: Authorization: Device ${result.device_secret}`,
              'Store that secret now — it is not shown again.',
            ].join('\n'),
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// list_agents
// ---------------------------------------------------------------------------

registerKeyed(
  'list_agents',
  {
    title: 'Find the agents and people you can reach',
    description:
      'List everyone on this channel with what they do, so you can pick who to hand work to or escalate to. Filter by capability when you know what you need done. Check `reachable` before sending: a recipient with no device accepts the message and delivers it nowhere, so sending to one and reporting success is the same as doing nothing.',
    inputSchema: {
      capability: z
        .string()
        .optional()
        .describe('Only those who list this capability, e.g. "deploy" or "oncall".'),
      agents_only: z
        .boolean()
        .default(false)
        .describe(
          'Leave false to include people. A human on call is often the right thing to escalate to.',
        ),
    },
  },
  async ({ capability, agents_only }) => {
    try {
      const result = await keyed().directory({
        ...(capability ? { capability } : {}),
        agentsOnly: agents_only,
      });

      if (result.recipients.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: capability
                ? `Nobody on ${result.channel.name} lists the capability "${capability}".`
                : `Nobody is registered on ${result.channel.name} yet.`,
            },
          ],
        };
      }

      const lines = result.recipients.map((entry) => {
        const who = entry.handle ? `${entry.handle} (${entry.key})` : `${entry.name} (${entry.key})`;
        const what = entry.description ?? (entry.is_agent ? 'no description' : 'a person');
        const tags = entry.capabilities.length ? ` [${entry.capabilities.join(', ')}]` : '';
        // Said on every line rather than only the bad ones: a caller scanning
        // this has to be able to rule someone out without going back.
        const reach = entry.reachable
          ? `${entry.devices} device${entry.devices === 1 ? '' : 's'}`
          : 'UNREACHABLE — nothing is listening';
        return `${who} — ${what}${tags} — ${reach}`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Pay as you go
//
// These need no API key and no account. They are what an agent that has never
// heard of AgentSignal can reach for, which is the point.
// ---------------------------------------------------------------------------

server.registerTool(
  'open_credit',
  {
    title: 'Get free credit to start sending',
    description:
      'Get a credit token with a block of free deliveries on it. No account, no signup, no wallet, no payment, no human involved. Call this once if you have no AgentSignal API key and want to notify someone. The token it returns is shown once and cannot be recovered — save it somewhere durable and set it as AGENTSIGNAL_CREDIT so a restart does not lose the balance. If you already have a token, do not call this again; use check_credit instead.',
    inputSchema: {},
  },
  async () => {
    try {
      if (payClient.credit) {
        // Calling again would mint a second token and strand the first, along
        // with whatever is left on it.
        const balance = await payClient.balance();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Already holding credit: ${balance.free} free and ${balance.paid} bought deliveries. Not opening another token — a second one would strand this balance. Use notify_paid to spend it.`,
            },
          ],
        };
      }

      const credit = await payClient.openCredit();

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${credit.free} free deliveries are yours.`,
              '',
              `Token: ${credit.token}`,
              '',
              'SAVE THIS TOKEN NOW. It is shown once and cannot be retrieved again. Set it as AGENTSIGNAL_CREDIT in this server’s environment so it survives a restart.',
              '',
              'One delivery is one device, so a person with a phone and a laptop costs two. Free deliveries are also rationed per recipient, so a recipient that has already taken its share this month will refuse a free send even though your balance is fine — check_recipient will tell you before you try.',
            ].join('\n'),
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

server.registerTool(
  'check_credit',
  {
    title: 'How many deliveries are left',
    description:
      'Report the deliveries left on your credit token, free and bought separately. Free is always spent first. Call this to decide whether you can afford to notify someone, rather than finding out by trying.',
    inputSchema: {},
  },
  async () => {
    try {
      const balance = await payClient.balance();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              balance.total === 0
                ? 'Nothing left on this token. A pack has to be bought with a wallet that can sign an x402 payment; this server cannot do that for you.'
                : `${balance.free} free and ${balance.paid} bought — ${balance.total} deliveries in total. Free is spent first.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

server.registerTool(
  'check_recipient',
  {
    title: 'What a send would cost, before sending it',
    description:
      'Ask what notifying someone would cost in deliveries, and whether they accept free sends at all. Needs no credit token. Worth calling before notify_paid when the balance is tight: the answer distinguishes "this recipient is out of free traffic this month" from "you are out of credit", which need different responses from you.',
    inputSchema: {
      recipient_key: z
        .string()
        .describe('The recipient key you were given, e.g. "u_8fk2…".'),
    },
  },
  async ({ recipient_key }) => {
    try {
      const quote = await payClient.quote(recipient_key);
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${quote.devices} device${quote.devices === 1 ? '' : 's'} — one message costs ${quote.costs_deliveries} deliver${quote.costs_deliveries === 1 ? 'y' : 'ies'}.`,
              quote.free.accepted
                ? `Free sends accepted; ${quote.free.allowance_remaining} left in this recipient's window.`
                : 'This channel declines free sends. Paid sends still work, and need a wallet.',
            ].join(' '),
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

server.registerTool(
  'notify_paid',
  {
    title: 'Notify someone using credit rather than an account',
    description:
      'Send a push notification drawing on your credit token instead of an API key. Use this when you have no AgentSignal account. Addresses exactly one recipient key — groups and broadcasts cannot be paid for, so being given one key never lets you reach a whole organisation. Call open_credit first if you have no token.',
    inputSchema: {
      to: z.string().describe('The recipient key you were given, e.g. "u_8fk2…".'),
      body: z
        .string()
        .max(1024)
        .describe(
          'What the person will read on their lock screen. Say what happened and what it means for them; they may have no other context.',
        ),
      title: z
        .string()
        .max(250)
        .optional()
        .describe('Bold first line. Defaults to the channel name.'),
      priority: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe(
          'normal is the default. high is delivered at once and marked time-sensitive, so use it only when interrupting is warranted -- it does not get past Do Not Disturb. Emergency alerts that repeat until acknowledged need an account.',
        ),
      url: z.string().url().optional().describe('A link shown under the message.'),
    },
  },
  async ({ to, body, title, priority, url }) => {
    try {
      const result = await payClient.send({
        to,
        body,
        priority: priority === 'high' ? 1 : priority === 'low' ? -1 : 0,
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
      });

      if (result.replayed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Already sent — this was an idempotent replay, and it cost nothing.',
            },
          ],
        };
      }

      const { sent, queued, failed, total } = result.deliveries;

      if (total === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'That recipient has no registered devices, so nothing was delivered and nothing was charged.',
            },
          ],
        };
      }

      // A send that bought its way through mints a token when there was none.
      // Saying so is the only chance the agent gets.
      const minted = result.credit?.token
        ? `\n\nA pack was bought and a new token minted: ${result.credit.token} — SAVE IT, it is shown once.`
        : '';

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Delivered to ${sent} of ${total} device${total === 1 ? '' : 's'}` +
              `${queued > 0 ? `, ${queued} queued for retry` : ''}` +
              `${failed > 0 ? `, ${failed} failed` : ''}. ` +
              `Spent ${result.credit.spent.free} free and ${result.credit.spent.paid} bought; ` +
              `${result.credit.free} free and ${result.credit.paid} bought left.` +
              minted,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Last, deliberately.
//
// This used to sit halfway up the file, with two tools registered after it.
// Whether a client ever saw those two was a race between its own tools/list
// and the rest of this module evaluating.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// An agent acting as itself
//
// These need the device credential that register_self hands back, not an API
// key. Registered only when one is present, for the same reason as everything
// else here: a tool a model can see is a tool it will try.
// ---------------------------------------------------------------------------

let selfClient = process.env.AGENTSIGNAL_DEVICE_SECRET
  ? new AgentSelf({ credential: process.env.AGENTSIGNAL_DEVICE_SECRET, baseUrl })
  : null;

/**
 * A join token is enough to become an agent, so the self tools are offered
 * when either is present -- the credential you already have, or the one thing
 * that can get you one.
 */
const canBeSelf = Boolean(selfClient) || Boolean(process.env.AGENTSIGNAL_JOIN_TOKEN);

const registerSelfTool: typeof server.registerTool = canBeSelf
  ? server.registerTool.bind(server)
  : (((..._args: unknown[]) => undefined) as never);

function mine(): AgentSelf {
  if (!selfClient) {
    throw new AgentSignalError(
      'no_credential',
      'You are not registered yet. Call join_channel first — a join token is all it needs — then save the credential it returns.',
    );
  }
  return selfClient;
}

registerSelfTool(
  'join_channel',
  {
    title: 'Become an addressable agent',
    description:
      'Register yourself using the join token in this server\u2019s environment. No API key and no account needed: a join token can create an agent and nothing else, which is why it is safe to be sitting in a config file. Pick a stable handle and reuse it on every start \u2014 the same handle is the same agent, so restarting rejoins rather than creating a second copy of you. Call this once, before read_inbox or notify_as_self, if you are not registered yet.',
    inputSchema: {
      handle: z
        .string()
        .describe('Stable id for you, lowercase with dashes, e.g. "deploy-bot".'),
      description: z
        .string()
        .max(280)
        .optional()
        .describe(
          'One line on what you do. This is what another agent reads when choosing between you and somebody else, so be concrete.',
        ),
      capabilities: z
        .array(z.string())
        .max(20)
        .optional()
        .describe('Short tags others can search on, e.g. ["deploy", "rollback"].'),
    },
  },
  async ({ handle, description, capabilities }) => {
    try {
      const token = process.env.AGENTSIGNAL_JOIN_TOKEN;

      if (!token) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No join token in this server\u2019s environment. Ask whoever runs it to set AGENTSIGNAL_JOIN_TOKEN, or set AGENTSIGNAL_DEVICE_SECRET if you already registered once.',
            },
          ],
          isError: true as const,
        };
      }

      const { agent, registration } = await AgentSelf.join(
        token,
        {
          handle,
          ...(description ? { description } : {}),
          ...(capabilities ? { capabilities } : {}),
        },
        { baseUrl },
      );

      // Adopted for the rest of this process. A stdio server dies with its
      // process, so this is gone on restart unless the credential is saved.
      selfClient = agent;

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              registration.created
                ? `Registered as ${registration.agent.handle}.`
                : `Already registered as ${registration.agent.handle} \u2014 this is you coming back, not a second copy.`,
              `Others reach you at ${registration.agent.key}.`,
              '',
              `Credential: ${registration.device_secret}`,
              '',
              'SAVE THIS. It is shown once, and it is what read_inbox and notify_as_self use. Set it as AGENTSIGNAL_DEVICE_SECRET so a restart does not have to rejoin.',
            ].join('\n'),
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'notify_as_self',
  {
    title: 'Send a notification as yourself',
    description:
      'Send to a person or another agent, as you rather than as a shared key \u2014 so the delivery log names you. You can reach whoever you share a channel with, and nobody else; find_agents_in_my_channels shows exactly who that is. For something a human must answer before you continue, set priority to "emergency" and wait_for_acknowledgement.',
    inputSchema: {
      to: z.string().describe('The recipient key (u_\u2026) of somebody you share a channel with.'),
      body: z
        .string()
        .max(1024)
        .describe('What they will read. Say what happened and what it means for them.'),
      title: z.string().max(250).optional(),
      priority: z
        .enum(['low', 'normal', 'high', 'emergency'])
        .optional()
        .describe(
          'normal is the default. emergency repeats on every device until somebody acknowledges, so use it only when not being seen is worse than being woken.',
        ),
      channel: z
        .string()
        .optional()
        .describe('Which shared channel to send through. Only needed when you share several.'),
      wait_for_acknowledgement: z
        .boolean()
        .optional()
        .describe('Emergency only. Blocks until somebody answers, or until it expires.'),
    },
  },
  async ({ to, body, title, priority, channel, wait_for_acknowledgement }) => {
    try {
      const payload = {
        to,
        body,
        ...(title ? { title } : {}),
        ...(channel ? { channel } : {}),
      };

      if (priority === 'emergency') {
        if (wait_for_acknowledgement) {
          const outcome = await mine().alertAndWait(payload);
          return {
            content: [
              {
                type: 'text' as const,
                text: outcome.acknowledged
                  ? 'Acknowledged by a human. You may proceed.'
                  : 'Nobody acknowledged before it expired. Do NOT proceed as though it was approved \u2014 silence is not consent.',
              },
            ],
          };
        }

        const alerted = await mine().alert(payload);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Alerting, and repeating until acknowledged. Receipt ${alerted.receipt}.`,
            },
          ],
        };
      }

      const result = await mine().send({
        ...payload,
        priority: priority === 'high' ? 1 : priority === 'low' ? -1 : 0,
      });

      if (result.deliveries.total === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'That recipient has no registered devices, so nothing was delivered.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Delivered to ${result.deliveries.sent} of ${result.deliveries.total} device${result.deliveries.total === 1 ? '' : 's'}.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'read_inbox',
  {
    title: 'Read what other agents have sent you',
    description:
      'Fetch the messages waiting for you. Nothing is pushed to an agent with no address of its own — this is you coming to ask, so poll it on whatever schedule suits your work. Pass `since` with the timestamp of the last message you handled so a restart does not replay everything. A message with `options` is a question: answer it with respond_to_message.',
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe('ISO timestamp. Only messages newer than this are returned.'),
    },
  },
  async ({ since }) => {
    try {
      const messages = await mine().inbox(since ? { since } : {});

      if (messages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Nothing waiting.' }] };
      }

      const lines = messages.map((m) =>
        [
          `[${m.delivery_id}] ${m.created_at}`,
          m.title ? `${m.title}: ` : '',
          m.body ?? '',
          m.options?.length ? `  — asks you to answer: ${m.options.join(' / ')}` : '',
        ].join(''),
      );

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'respond_to_message',
  {
    title: 'Answer a question another agent asked you',
    description:
      'Reply to a message that came with options. The sender is waiting on this, so answer with exactly one of the options it offered.',
    inputSchema: {
      delivery_id: z.string().describe('The id in square brackets from read_inbox.'),
      answer: z.string().describe('One of the options the message offered, exactly as written.'),
    },
  },
  async ({ delivery_id, answer }) => {
    try {
      await mine().respond(delivery_id, answer);
      return { content: [{ type: 'text' as const, text: `Answered "${answer}".` }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'my_channels',
  {
    title: 'The channels you are reachable in',
    description:
      'List the channels you can be addressed through. One of them is your home channel — where you live, and the one you cannot leave. Channels marked as yours are ones you created and therefore manage.',
    inputSchema: {},
  },
  async () => {
    try {
      const channels = await mine().channels();
      const lines = channels.map(
        (l) =>
          `${l.ref}  ${l.name}  ${[
            l.is_home ? 'home' : null,
            l.mine ? 'yours to manage' : null,
            `${l.members} member${l.members === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · ')}`,
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'create_channel',
  {
    title: 'Make a channel you run',
    description:
      'Create a channel — a room you own and can put other agents into, so they can find and message each other there. It is created in the account you already belong to; there is no way to make a new account, and no billing changes. It carries no branding of its own: what a channel looks like on a person’s lock screen is not something an agent chooses, so it inherits the account’s brand until a human sets otherwise.',
    inputSchema: {
      name: z.string().max(80).describe('What the channel is called. 1 to 80 characters.'),
      description: z.string().optional().describe('One line on what it is for.'),
    },
  },
  async ({ name, description }) => {
    try {
      const channel = await mine().createChannel(name, description);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created "${channel.name}" — ref ${channel.ref}. Use that ref to add agents to it.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'add_agent_to_channel',
  {
    title: 'Put another agent in a channel you made',
    description:
      'Add an agent to one of your channels so it can be found and messaged there. Only agents, and only agents in the same account: pulling a person into a channel an agent named would be one step from a convincing notification from their bank, and reaching into another account would let you decide what somebody else is reachable for. Only the agent that created a channel can add to it.',
    inputSchema: {
      channel_ref: z.string().describe('The ref from create_channel or my_channels.'),
      agent: z.string().describe('A recipient key (u_…) or a handle.'),
    },
  },
  async ({ channel_ref, agent }) => {
    try {
      await mine().addToChannel(channel_ref, agent);
      return {
        content: [{ type: 'text' as const, text: `${agent} is now reachable in ${channel_ref}.` }],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'remove_agent_from_channel',
  {
    title: 'Take an agent out of a channel',
    description:
      'Remove an agent from a channel you created, or remove yourself from any channel. You cannot leave your home channel — that is where you live, and leaving it would make you unreachable everywhere at once.',
    inputSchema: {
      channel_ref: z.string(),
      agent_key: z.string().describe('The recipient key (u_…) to remove. Your own to leave.'),
    },
  },
  async ({ channel_ref, agent_key }) => {
    try {
      await mine().removeFromChannel(channel_ref, agent_key);
      return {
        content: [{ type: 'text' as const, text: `${agent_key} removed from ${channel_ref}.` }],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerSelfTool(
  'find_agents_in_my_channels',
  {
    title: 'Who else is reachable, across the channels you are in',
    description:
      'Search the agents and people you share a channel with, by what they do. Joining a channel is what makes others visible to you — there is nothing to browse in a channel you were never added to. Check `reachable` before sending: a recipient with no devices accepts a message and delivers it nowhere.',
    inputSchema: {
      channel_ref: z.string().optional().describe('Limit to one channel. Omit to search all of yours.'),
      capability: z
        .string()
        .optional()
        .describe('Only those that list this capability, e.g. "oncall".'),
      agents_only: z.boolean().optional().describe('Leave out the people.'),
    },
  },
  async ({ channel_ref, capability, agents_only }) => {
    try {
      const entries = await mine().directory({
        ...(channel_ref ? { channelRef: channel_ref } : {}),
        ...(capability ? { capability } : {}),
        ...(agents_only ? { agentsOnly: true } : {}),
      });

      if (entries.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Nobody matches. Try without a capability filter, or create a channel and add the agents you need.',
            },
          ],
        };
      }

      const lines = entries.map((e) => {
        const who = e.handle ? `${e.handle} (${e.key})` : `${e.name} (${e.key})`;
        const what = e.description ?? (e.is_agent ? 'no description' : 'a person');
        const tags = e.capabilities.length ? ` [${e.capabilities.join(', ')}]` : '';
        const reach = e.reachable
          ? `${e.devices} device${e.devices === 1 ? '' : 's'}`
          : 'UNREACHABLE — nothing is listening';
        return `${who} — ${what}${tags} — ${reach}`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);


// ---------------------------------------------------------------------------
// Groups
//
// Keyed, because a group belongs to a channel and an API key is the credential
// that names one. That an agent can build one is the point: an on-call rota a
// human maintains by hand is a rota that is wrong by Tuesday.
// ---------------------------------------------------------------------------

registerKeyed(
  'list_groups',
  {
    title: 'Groups you can notify by name',
    description:
      'List the groups in this channel. `deliveries` is what one send to that group actually costs — one per device across every member — so check it before notifying a large group. `unreachable` counts members with no paired device: they accept a message and receive nothing.',
    inputSchema: {},
  },
  async () => {
    try {
      const groups = await keyed().groups();

      if (groups.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No groups yet. create_group makes one, then add_to_group fills it.',
            },
          ],
        };
      }

      const lines = groups.map(
        (g) =>
          `${g.slug} — ${g.name} — ${g.members} member${g.members === 1 ? '' : 's'}, ` +
          `${g.deliveries} deliveries per send` +
          (g.unreachable > 0 ? `, ${g.unreachable} UNREACHABLE` : ''),
      );

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerKeyed(
  'create_group',
  {
    title: 'Make a group you can notify by name',
    description:
      'Create a group, then add people or agents to it with add_to_group. Send to it by passing its slug as `group` instead of `to`. Use this when the same set of people needs to hear about something repeatedly — an on-call rota, a team, everybody who cares about one service.',
    inputSchema: {
      name: z.string().max(80).describe('What the group is called, e.g. "On call".'),
      slug: z
        .string()
        .optional()
        .describe('What you address it by. Derived from the name if you leave it out.'),
    },
  },
  async ({ name, slug }) => {
    try {
      const group = await keyed().createGroup(name, slug);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created "${group.name}". Send to it with group: "${group.slug}".`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerKeyed(
  'add_to_group',
  {
    title: 'Put somebody in a group',
    description:
      'Add a person or an agent to a group. They must already be reachable in this channel — a group is a shorthand for people you can address, not a way to reach new ones.',
    inputSchema: {
      group: z.string().describe('The group slug.'),
      recipient: z.string().describe('A recipient key (u_…), a handle, or an id.'),
    },
  },
  async ({ group, recipient }) => {
    try {
      await keyed().addToGroup(group, recipient);
      return { content: [{ type: 'text' as const, text: `${recipient} is now in ${group}.` }] };
    } catch (error) {
      return toToolError(error);
    }
  },
);

registerKeyed(
  'notify_group',
  {
    title: 'Notify everybody in a group',
    description:
      'Send one message to every member of a group. This costs one delivery per device across all of them, so call list_groups first if you do not know how large it is. For a single person use notify instead.',
    inputSchema: {
      group: z.string().describe('The group slug, from list_groups.'),
      body: z
        .string()
        .max(1024)
        .describe('What everyone will read. Say what happened and what it means for them.'),
      title: z.string().max(250).optional(),
      priority: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('normal is the default. high is for something that should interrupt.'),
    },
  },
  async ({ group, body, title, priority }) => {
    try {
      const result = await keyed().send({
        group,
        body,
        priority: priority === 'high' ? 1 : priority === 'low' ? -1 : 0,
        ...(title ? { title } : {}),
      });

      if (result.deliveries.total === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `"${group}" has no reachable members, so nothing was delivered. Check list_groups.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Delivered to ${result.deliveries.sent} of ${result.deliveries.total} devices across ${group}.`,
          },
        ],
      };
    } catch (error) {
      return toToolError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
