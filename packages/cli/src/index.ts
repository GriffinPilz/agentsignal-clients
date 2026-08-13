#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  AgentSignal,
  AgentSignalError,
  AgentSignalX402,
  AgentSelf,
  PaymentRequiredError,
  QuotaExceededError,
} from '@agentsignal/sdk';

const CONFIG_PATH = join(homedir(), '.config', 'agentsignal', 'config.json');

interface Config {
  apiKey?: string;
  baseUrl?: string;
  /** A pay-as-you-go credit token. Spends money, so it lives behind the same 0600. */
  credit?: string;
  /** An agent's own device credential, from `agents register`. */
  deviceSecret?: string;
}

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  // The file holds an API key. Owner-only, or it is readable by anything else
  // running as another user on a shared machine.
  chmodSync(CONFIG_PATH, 0o600);
}

/**
 * Merge into the stored config rather than replacing it.
 *
 * `login` writes the whole object, which is right for it -- signing in again
 * should not inherit a stale base URL. Saving a credit token must not throw
 * away the API key sitting next to it.
 */
function updateConfig(patch: Partial<Config>): void {
  writeConfig({ ...readConfig(), ...patch });
}

function client(): AgentSignal {
  const config = readConfig();
  const apiKey = process.env.AGENTSIGNAL_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(
      pc.red('No API key.'),
      '\nRun',
      pc.bold('agentsignal login'),
      'or set',
      pc.bold('AGENTSIGNAL_API_KEY') + '.',
    );
    process.exit(1);
  }

  return new AgentSignal({
    apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

const PRIORITIES: Record<string, number> = {
  lowest: -2,
  low: -1,
  normal: 0,
  high: 1,
  emergency: 2,
};

function parsePriority(value: string): number {
  if (value in PRIORITIES) return PRIORITIES[value]!;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= -2 && numeric <= 2) return numeric;
  throw new Error(
    `Priority must be one of ${Object.keys(PRIORITIES).join(', ')}, or -2 to 2.`,
  );
}

/**
 * A pay-as-you-go client.
 *
 * Unlike `client()` this does not exit when there is no credential: `x402
 * quote` and `x402 packs` are public, and `x402 open` is how you get one in
 * the first place. The SDK refuses the calls that genuinely need a token.
 */
function payClient(): AgentSignalX402 {
  const config = readConfig();
  const credit = process.env.AGENTSIGNAL_CREDIT ?? config.credit;
  return new AgentSignalX402({
    ...(credit ? { credit } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

function reportError(error: unknown): never {
  if (error instanceof PaymentRequiredError) {
    console.error(pc.yellow('Payment required.'), error.message);
    if (error.reason === 'free_allowance_exhausted') {
      console.error(
        pc.dim(
          'This is the recipient’s limit, not yours — your free credit still works elsewhere.',
        ),
      );
    }
    if (error.packs.length > 0) {
      console.error(
        pc.dim('On sale:'),
        error.packs
          .map((p) => `${p.code} → ${p.deliveries.toLocaleString()} deliveries`)
          .join(pc.dim(' · ')),
      );
    }
    // Paying needs a wallet, which this CLI deliberately does not hold.
    console.error(
      pc.dim('Buying a pack needs a wallet. Use the SDK with an x402-wrapped fetch.'),
    );
    process.exit(2);
  } else if (error instanceof QuotaExceededError) {
    console.error(pc.red('Quota exhausted.'), error.message);
  } else if (error instanceof AgentSignalError) {
    console.error(pc.red(`${error.code}:`), error.message);
  } else if (error instanceof Error) {
    console.error(pc.red('Error:'), error.message);
  } else {
    console.error(pc.red('Error:'), String(error));
  }
  process.exit(1);
}

/** Accumulator for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name('agentsignal')
  .description('Push notifications for agents.')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

program
  .command('login')
  .description('Store an API key for future commands')
  .option('--base-url <url>', 'Point at a different API (for self-hosting or local dev)')
  .action(async (options: { baseUrl?: string }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const apiKey = (
      await rl.question('API key (from your dashboard): ')
    ).trim();
    rl.close();

    if (!/^as_(live|test)_/.test(apiKey)) {
      console.error(pc.red('That does not look like an AgentSignal key.'));
      process.exit(1);
    }

    writeConfig({
      apiKey,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });

    console.log(pc.green('Saved to'), CONFIG_PATH, pc.dim('(owner-readable only)'));
    if (apiKey.startsWith('as_test_')) {
      // Sandboxes stopped having their own allowance when they started sharing
      // the plan's: a separate ceiling just made the cheapest way to send N
      // notifications "send half of them through a sandbox".
      console.log(
        pc.yellow('This is a sandbox key.'),
        pc.dim('History here is disposable, but sends still count against the plan.'),
      );
    }
  });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

program
  .command('send')
  .description('Send a notification')
  .argument('<body>', 'The message body. Use - to read from stdin.')
  .option('-t, --to <recipient>', 'Recipient key, e.g. u_8fk2…')
  .option('-g, --to-group <slug>', 'Send to everybody in a group instead')
  .option('-T, --title <title>', 'Title. Defaults to the channel name.')
  .option(
    '-p, --priority <level>',
    'lowest | low | normal | high | emergency',
    'normal',
  )
  .option('-u, --url <url>', 'A link shown under the message')
  .option('--url-title <text>', 'Label for that link')
  // Repeatable rather than variadic: a variadic option greedily consumes
  // everything up to the next flag, which silently eats the message body.
  .option('--tag <tag>', 'Tag, repeatable', collect, [])
  .option('--wait', 'For emergency: block until a human acknowledges')
  .action(async (body: string, options: Record<string, string | string[] | boolean>) => {
    try {
      const text =
        body === '-' ? readFileSync(0, 'utf8').trim() : body;

      if (!text) {
        console.error(pc.red('Nothing to send.'));
        process.exit(1);
      }

      const priority = parsePriority(String(options.priority));
      const as = client();

      if (!options.to === !options.toGroup) {
        console.error(pc.red('Address exactly one of --to or --to-group.'));
        process.exit(1);
      }

      const payload = {
        ...(options.toGroup
          ? { group: String(options.toGroup) }
          : { to: String(options.to) }),
        body: text,
        priority,
        ...(options.title ? { title: String(options.title) } : {}),
        ...(options.url ? { url: String(options.url) } : {}),
        ...(options.urlTitle ? { url_title: String(options.urlTitle) } : {}),
        ...((options.tag as string[])?.length
          ? { tags: options.tag as string[] }
          : {}),
      };

      if (priority === 2 && options.wait) {
        console.log(pc.dim('Alerting, and waiting for acknowledgement…'));
        const outcome = await as.alertAndWait(payload);
        if (outcome.acknowledged) {
          console.log(pc.green('Acknowledged.'));
          return;
        }
        console.error(pc.yellow('Expired without acknowledgement.'));
        // Non-zero so `&&` chains in a script do not proceed unapproved.
        process.exit(2);
      }

      const result = await as.send(payload);
      const { sent, failed, queued, total } = result.deliveries;

      if (result.replayed) {
        console.log(pc.dim('Already sent (idempotent replay).'), result.id);
        return;
      }

      const parts = [
        sent > 0 ? pc.green(`${sent} sent`) : null,
        queued > 0 ? pc.yellow(`${queued} queued`) : null,
        failed > 0 ? pc.red(`${failed} failed`) : null,
      ].filter(Boolean);

      if (total === 0) {
        console.log(
          pc.yellow('No devices.'),
          pc.dim('That person has not paired anything yet.'),
        );
      } else {
        console.log(parts.join(pc.dim(' · ')), pc.dim(`— ${result.id}`));
      }

      if (result.receipt) {
        console.log(pc.dim('Receipt:'), result.receipt);
      }
    } catch (error) {
      reportError(error);
    }
  });

// ---------------------------------------------------------------------------
// alert
// ---------------------------------------------------------------------------

program
  .command('alert')
  .description('Send an emergency alert that repeats until acknowledged')
  .argument('<body>')
  .requiredOption('-t, --to <recipient>')
  .option('-T, --title <title>')
  .option('--retry <seconds>', 'Seconds between re-alerts', '60')
  .option('--expire <seconds>', 'Give up after this many seconds', '3600')
  .option('--wait', 'Block until acknowledged')
  .action(async (body: string, options: Record<string, string | boolean>) => {
    try {
      const as = client();
      const payload = {
        to: String(options.to),
        body,
        retry_seconds: Number(options.retry),
        expire_seconds: Number(options.expire),
        ...(options.title ? { title: String(options.title) } : {}),
      };

      if (options.wait) {
        console.log(pc.dim('Alerting, and waiting…'));
        const outcome = await as.alertAndWait(payload);
        console.log(
          outcome.acknowledged
            ? pc.green('Acknowledged.')
            : pc.yellow('Expired without acknowledgement.'),
        );
        process.exit(outcome.acknowledged ? 0 : 2);
      }

      const result = await as.alert(payload);
      console.log(
        pc.red('Emergency sent.'),
        pc.dim(`${result.deliveries.total} devices · receipt ${result.receipt}`),
      );
    } catch (error) {
      reportError(error);
    }
  });

// ---------------------------------------------------------------------------
// receipt
// ---------------------------------------------------------------------------

program
  .command('receipt')
  .description('Check whether an emergency alert was acknowledged')
  .argument('<receiptId>')
  .action(async (receiptId: string) => {
    try {
      const result = await client().receipt(receiptId);
      if (result.acknowledged) {
        console.log(pc.green('Acknowledged'), pc.dim(result.acked_at ?? ''));
      } else {
        console.log(pc.yellow('Not yet acknowledged'));
        process.exit(2);
      }
    } catch (error) {
      reportError(error);
    }
  });

// ---------------------------------------------------------------------------
// x402 — sending with no account
//
// Its own command group rather than a flag on `send`, because it is a
// different credential reaching a different endpoint with a different failure
// mode. `--pay` on `send` would have made "which key am I spending?" a thing
// you work out from flags.
// ---------------------------------------------------------------------------

const x402 = program
  .command('x402')
  .description('Pay as you go: send with no account, starting with a free block');

x402
  .command('open')
  .description('Get a credit token with the free block on it, and save it')
  .option('--print', 'Print the token instead of saving it')
  .action(async (options: { print?: boolean }) => {
    try {
      const as = payClient();
      const credit = await as.openCredit();

      if (options.print) {
        console.log(credit.token);
        return;
      }

      updateConfig({ credit: credit.token });
      console.log(
        pc.green(`${credit.free.toLocaleString()} free deliveries.`),
        pc.dim(`Saved to ${CONFIG_PATH}`),
      );
      // Said once, here, because it is the only moment it can be said.
      console.log(
        pc.dim('The token is shown once and cannot be recovered. It is now in that file.'),
      );
    } catch (error) {
      reportError(error);
    }
  });

x402
  .command('balance')
  .description('What is left on the saved credit token')
  .action(async () => {
    try {
      const balance = await payClient().balance();
      const parts = [
        balance.free > 0 ? pc.green(`${balance.free.toLocaleString()} free`) : null,
        balance.paid > 0
          ? pc.cyan(`${balance.paid.toLocaleString()} bought`)
          : null,
      ].filter(Boolean);

      if (parts.length === 0) {
        console.log(pc.yellow('Nothing left.'), pc.dim('Buy a pack to keep sending.'));
        process.exit(2);
      }

      console.log(parts.join(pc.dim(' · ')), pc.dim('— free is spent first'));
    } catch (error) {
      reportError(error);
    }
  });

x402
  .command('packs')
  .description('The price list, and how big the free block is')
  .action(async () => {
    try {
      const result = await payClient().packs();
      console.log(
        pc.green('Free'),
        pc.dim(`— ${result.free.deliveries.toLocaleString()} deliveries, ${result.free.open}`),
      );
      for (const pack of result.packs) {
        console.log(
          pc.bold(pack.code),
          pc.dim(`— ${pack.deliveries.toLocaleString()} deliveries`),
        );
      }
      console.log(pc.dim(`${result.asset} on ${result.network}.`));
    } catch (error) {
      reportError(error);
    }
  });

x402
  .command('quote')
  .description('What a send would cost, and whether free credit is welcome there')
  .argument('<recipient>', 'Recipient key, e.g. u_8fk2…')
  .action(async (recipient: string) => {
    try {
      const quote = await payClient().quote(recipient);
      console.log(
        pc.bold(`${quote.devices} device${quote.devices === 1 ? '' : 's'}`),
        pc.dim(`— ${quote.costs_deliveries} deliver${quote.costs_deliveries === 1 ? 'y' : 'ies'} per message`),
      );

      if (quote.free.accepted) {
        console.log(
          pc.green('Free sends accepted.'),
          pc.dim(`${quote.free.allowance_remaining.toLocaleString()} left in this recipient’s window`),
        );
      } else {
        // Worth stating plainly: it is a decision by the channel, not a fault
        // with the caller's token.
        console.log(pc.yellow('Free sends declined by this channel.'), pc.dim('Paid sends still work.'));
      }
    } catch (error) {
      reportError(error);
    }
  });

x402
  .command('send')
  .description('Send, drawing on credit rather than an API key')
  .argument('<body>', 'The message body. Use - to read from stdin.')
  .requiredOption('-t, --to <recipient>', 'Recipient key, e.g. u_8fk2…')
  .option('-T, --title <title>')
  .option('-p, --priority <level>', 'lowest | low | normal | high | emergency', 'normal')
  .option('-u, --url <url>')
  .option('--url-title <text>')
  .option('--tag <tag>', 'Tag, repeatable', collect, [])
  .action(async (body: string, options: Record<string, string | string[]>) => {
    try {
      const text = body === '-' ? readFileSync(0, 'utf8').trim() : body;

      if (!text) {
        console.error(pc.red('Nothing to send.'));
        process.exit(1);
      }

      const as = payClient();
      const result = await as.send({
        to: String(options.to),
        body: text,
        priority: parsePriority(String(options.priority)),
        ...(options.title ? { title: String(options.title) } : {}),
        ...(options.url ? { url: String(options.url) } : {}),
        ...(options.urlTitle ? { url_title: String(options.urlTitle) } : {}),
        ...((options.tag as string[])?.length ? { tags: options.tag as string[] } : {}),
      });

      // A send that paid its way mints a token when there was none. Persist it
      // before saying anything else, or the money bought a balance nothing
      // here can reach again.
      if (result.credit?.token) updateConfig({ credit: result.credit.token });

      if (result.replayed) {
        console.log(pc.dim('Already sent (idempotent replay).'), result.id);
        return;
      }

      const { sent, failed, queued } = result.deliveries;
      const parts = [
        sent > 0 ? pc.green(`${sent} sent`) : null,
        queued > 0 ? pc.yellow(`${queued} queued`) : null,
        failed > 0 ? pc.red(`${failed} failed`) : null,
      ].filter(Boolean);

      console.log(parts.join(pc.dim(' · ')), pc.dim(`— ${result.id}`));
      console.log(
        pc.dim(
          `Spent ${result.credit.spent.free} free, ${result.credit.spent.paid} bought · ` +
            `${result.credit.free.toLocaleString()} free and ${result.credit.paid.toLocaleString()} bought left`,
        ),
      );
    } catch (error) {
      reportError(error);
    }
  });

// ---------------------------------------------------------------------------
// agents — an agent acting as itself
//
// A different credential from `login`: an API key says which channel you are
// sending through, and these commands all ask who you are.
// ---------------------------------------------------------------------------

/** The agent's own client. */
function selfClient(): AgentSelf {
  const config = readConfig();
  const credential = process.env.AGENTSIGNAL_DEVICE_SECRET ?? config.deviceSecret;

  if (!credential) {
    console.error(
      pc.red('No agent credential.'),
      '\nRun',
      pc.bold('agentsignal agents register <handle>'),
      'or set',
      pc.bold('AGENTSIGNAL_DEVICE_SECRET') + '.',
    );
    process.exit(1);
  }

  return new AgentSelf({
    credential,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

const agentsCmd = program
  .command('agents')
  .description('Register as an agent, read your inbox, and run channels');

agentsCmd
  .command('register')
  .description('Join this channel as an addressable agent, and save the credential')
  .argument('<handle>', 'Stable id, e.g. deploy-bot. The same handle is the same agent.')
  .option('-d, --description <text>', 'One line on what you do — this is what others choose on')
  .option('--capability <name>', 'Capability, repeatable', collect, [])
  .option('--endpoint <url>', 'An https URL to receive signed webhooks on')
  .action(async (handle: string, options: Record<string, string | string[]>) => {
    try {
      const result = await client().register({
        handle,
        ...(options.description ? { description: String(options.description) } : {}),
        ...((options.capability as string[])?.length
          ? { capabilities: options.capability as string[] }
          : {}),
        ...(options.endpoint ? { endpoint: String(options.endpoint) } : {}),
      });

      updateConfig({ deviceSecret: result.device_secret });

      console.log(
        result.created ? pc.green('Registered.') : pc.dim('Already registered — same agent.'),
        pc.bold(result.agent.key),
      );
      console.log(pc.dim(`Credential saved to ${CONFIG_PATH}. It is shown once.`));
      if (result.webhook_secret) {
        console.log(pc.yellow('Webhook secret:'), result.webhook_secret, pc.dim('(shown once)'));
      }
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('join')
  .description('Join with a join token — no API key needed')
  .argument('<handle>', 'Stable id for you, e.g. deploy-bot. The same handle is the same agent.')
  .option('--token <token>', 'The join token. Falls back to AGENTSIGNAL_JOIN_TOKEN.')
  .option('-d, --description <text>', 'One line on what you do — what others choose on')
  .option('--capability <name>', 'Capability, repeatable', collect, [])
  .action(async (handle: string, options: Record<string, string | string[]>) => {
    try {
      const token = String(options.token ?? process.env.AGENTSIGNAL_JOIN_TOKEN ?? '');

      if (!token) {
        console.error(
          pc.red('No join token.'),
          '\nPass',
          pc.bold('--token'),
          'or set',
          pc.bold('AGENTSIGNAL_JOIN_TOKEN') + '.',
        );
        process.exit(1);
      }

      const config = readConfig();
      const { registration } = await AgentSelf.join(
        token,
        {
          handle,
          ...(options.description ? { description: String(options.description) } : {}),
          ...((options.capability as string[])?.length
            ? { capabilities: options.capability as string[] }
            : {}),
        },
        config.baseUrl ? { baseUrl: config.baseUrl } : {},
      );

      updateConfig({ deviceSecret: registration.device_secret });

      console.log(
        registration.created ? pc.green('Joined.') : pc.dim('Already here — same agent.'),
        pc.bold(registration.agent.key),
      );
      console.log(pc.dim(`Credential saved to ${CONFIG_PATH}. It is shown once.`));
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('send')
  .description('Send as yourself, with no API key')
  .argument('<body>', 'The message body. Use - to read from stdin.')
  .requiredOption('-t, --to <recipient>', 'Recipient key. Somebody you share a channel with.')
  .option('-T, --title <title>')
  .option('-p, --priority <level>', 'lowest | low | normal | high | emergency', 'normal')
  .option('-l, --channel <ref>', 'Which shared channel to send through, when you share several')
  .option('--wait', 'For emergency: block until somebody acknowledges')
  .action(async (body: string, options: Record<string, string | boolean>) => {
    try {
      const text = body === '-' ? readFileSync(0, 'utf8').trim() : body;

      if (!text) {
        console.error(pc.red('Nothing to send.'));
        process.exit(1);
      }

      const priority = parsePriority(String(options.priority));
      const me = selfClient();
      const payload = {
        to: String(options.to),
        body: text,
        priority,
        ...(options.title ? { title: String(options.title) } : {}),
        ...(options.channel ? { channel: String(options.channel) } : {}),
      };

      if (priority === 2 && options.wait) {
        console.log(pc.dim('Alerting, and waiting for acknowledgement…'));
        const outcome = await me.alertAndWait(payload);
        if (outcome.acknowledged) {
          console.log(pc.green('Acknowledged.'));
          return;
        }
        console.error(pc.yellow('Expired without acknowledgement.'));
        // Non-zero so `&&` chains in a script do not proceed unapproved.
        process.exit(2);
      }

      const result = await me.send(payload);
      const { sent, queued, failed } = result.deliveries;

      console.log(
        [
          sent > 0 ? pc.green(`${sent} sent`) : null,
          queued > 0 ? pc.yellow(`${queued} queued`) : null,
          failed > 0 ? pc.red(`${failed} failed`) : null,
        ]
          .filter(Boolean)
          .join(pc.dim(' · ')),
        pc.dim(`— ${result.id}`),
      );
      if (result.receipt) console.log(pc.dim('Receipt:'), result.receipt);
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('inbox')
  .description('What has arrived for you')
  .option('--since <timestamp>', 'Only what is newer than this')
  .action(async (options: { since?: string }) => {
    try {
      const messages = await selfClient().inbox(
        options.since ? { since: options.since } : {},
      );

      if (messages.length === 0) {
        console.log(pc.dim('Nothing waiting.'));
        return;
      }

      for (const message of messages) {
        const head = [
          message.read_at ? pc.dim('·') : pc.green('•'),
          message.title ? pc.bold(message.title) : null,
          message.body,
        ]
          .filter(Boolean)
          .join(' ');
        console.log(head);
        console.log(
          pc.dim(`  ${message.delivery_id}  ${message.created_at}`),
          message.options?.length ? pc.dim(`  asks: ${message.options.join(' / ')}`) : '',
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('respond')
  .description('Answer a message that asked a question')
  .argument('<deliveryId>')
  .argument('<answer>')
  .action(async (deliveryId: string, answer: string) => {
    try {
      await selfClient().respond(deliveryId, answer);
      console.log(pc.green('Answered.'), pc.dim(answer));
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('channels')
  .description('The channels you are reachable in')
  .action(async () => {
    try {
      const channels = await selfClient().channels();
      for (const channel of channels) {
        console.log(
          pc.bold(channel.ref),
          channel.name,
          [
            channel.is_home ? pc.dim('home') : null,
            channel.mine ? pc.cyan('yours') : null,
            pc.dim(`${channel.members} member${channel.members === 1 ? '' : 's'}`),
          ]
            .filter(Boolean)
            .join(pc.dim(' · ')),
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('new-channel')
  .description('Create a channel you run, and can put other agents in')
  .argument('<name>')
  .option('-d, --description <text>')
  .action(async (name: string, options: { description?: string }) => {
    try {
      const channel = await selfClient().createChannel(name, options.description);
      console.log(pc.green('Created.'), pc.bold(channel.ref), channel.name);
      // Said here because it is the surprising part and somebody will
      // otherwise discover it by wondering why their icon never showed up.
      console.log(
        pc.dim('It uses the account brand — an agent does not choose what a person sees.'),
      );
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('add')
  .description('Put another agent in a channel you made')
  .argument('<channelRef>')
  .argument('<agent>', 'A recipient key or a handle')
  .action(async (channelRef: string, agent: string) => {
    try {
      await selfClient().addToChannel(channelRef, agent);
      console.log(pc.green('Added.'), pc.dim(`${agent} → ${channelRef}`));
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('remove')
  .description('Take an agent out of a channel. You can always remove yourself.')
  .argument('<channelRef>')
  .argument('<agentKey>')
  .action(async (channelRef: string, agentKey: string) => {
    try {
      await selfClient().removeFromChannel(channelRef, agentKey);
      console.log(pc.green('Removed.'), pc.dim(`${agentKey} from ${channelRef}`));
    } catch (error) {
      reportError(error);
    }
  });

agentsCmd
  .command('directory')
  .description('Who else is reachable, across your channels or inside one')
  .option('-l, --channel <ref>', 'Just this channel')
  .option('-c, --capability <name>', 'Only agents that do this')
  .option('--agents-only')
  .action(async (options: { channel?: string; capability?: string; agentsOnly?: boolean }) => {
    try {
      const entries = await selfClient().directory({
        ...(options.channel ? { channelRef: options.channel } : {}),
        ...(options.capability ? { capability: options.capability } : {}),
        ...(options.agentsOnly ? { agentsOnly: true } : {}),
      });

      for (const entry of entries) {
        console.log(
          pc.bold(entry.handle ?? entry.name),
          pc.dim(entry.key),
          entry.description ?? pc.dim(entry.is_agent ? 'no description' : 'a person'),
          entry.capabilities.length ? pc.dim(`[${entry.capabilities.join(', ')}]`) : '',
          // Said on every line: a caller scanning this has to be able to rule
          // somebody out without going back.
          entry.reachable ? pc.dim(`${entry.devices}d`) : pc.yellow('UNREACHABLE'),
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

// ---------------------------------------------------------------------------
// groups — one name that reaches several people
// ---------------------------------------------------------------------------

const groupsCmd = program
  .command('groups')
  .description('Make and manage groups you can send to by name');

groupsCmd
  .command('list', { isDefault: true })
  .description('Every group, and what a send to each would cost')
  .action(async () => {
    try {
      const groups = await client().groups();

      if (groups.length === 0) {
        console.log(pc.dim('No groups yet.'), pc.dim('agentsignal groups new "On call"'));
        return;
      }

      for (const group of groups) {
        console.log(
          pc.bold(group.slug),
          group.name,
          pc.dim(`${group.members} member${group.members === 1 ? '' : 's'}`),
          // The number that decides whether sending to this is a good idea.
          pc.dim(`· ${group.deliveries} deliver${group.deliveries === 1 ? 'y' : 'ies'} per send`),
          group.unreachable > 0 ? pc.yellow(`· ${group.unreachable} unreachable`) : '',
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

groupsCmd
  .command('show')
  .description('Who is in a group')
  .argument('<slug>')
  .action(async (slug: string) => {
    try {
      const { members } = await client().group(slug);
      for (const member of members) {
        console.log(
          pc.bold(member.handle ?? member.name),
          pc.dim(member.key),
          member.reachable
            ? pc.dim(`${member.devices} device${member.devices === 1 ? '' : 's'}`)
            : pc.yellow('UNREACHABLE'),
        );
      }
    } catch (error) {
      reportError(error);
    }
  });

groupsCmd
  .command('new')
  .description('Create a group')
  .argument('<name>')
  .option('-s, --slug <slug>', 'What you send to. Derived from the name otherwise.')
  .action(async (name: string, options: { slug?: string }) => {
    try {
      const group = await client().createGroup(name, options.slug);
      console.log(pc.green('Created.'), pc.bold(group.slug));
      console.log(pc.dim(`agentsignal send --to-group ${group.slug} "..."`));
    } catch (error) {
      reportError(error);
    }
  });

groupsCmd
  .command('add')
  .description('Put somebody in a group')
  .argument('<slug>')
  .argument('<recipient>', 'A recipient key, a handle, or an id')
  .action(async (slug: string, recipient: string) => {
    try {
      await client().addToGroup(slug, recipient);
      console.log(pc.green('Added.'), pc.dim(`${recipient} → ${slug}`));
    } catch (error) {
      reportError(error);
    }
  });

groupsCmd
  .command('remove')
  .description('Take somebody out of a group')
  .argument('<slug>')
  .argument('<recipient>')
  .action(async (slug: string, recipient: string) => {
    try {
      await client().removeFromGroup(slug, recipient);
      console.log(pc.green('Removed.'), pc.dim(`${recipient} from ${slug}`));
    } catch (error) {
      reportError(error);
    }
  });

groupsCmd
  .command('delete')
  .description('Delete a group. The people in it are unaffected.')
  .argument('<slug>')
  .action(async (slug: string) => {
    try {
      await client().deleteGroup(slug);
      console.log(pc.green('Deleted.'), pc.dim('The people in it are unaffected.'));
    } catch (error) {
      reportError(error);
    }
  });

program.parseAsync().catch(reportError);
