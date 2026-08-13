# @agentsignal/sdk

```bash
npm install @agentsignal/sdk
```

```ts
import { AgentSignal } from '@agentsignal/sdk';

const as = new AgentSignal(); // reads AGENTSIGNAL_API_KEY

await as.send({
  to: 'u_8fk2…',
  title: 'Deploy finished',
  body: 'prod is green',
  priority: 1,
});
```

## Retries won't double-notify

Every `send` gets an idempotency key, generated if you don't supply one and
reused across retries. A network error mid-flight is indistinguishable from a
failure, and retrying without a stable key is exactly how an agent wakes someone
up twice for the same event.

Transient failures (5xx, 429) retry with exponential backoff and jitter, so a
fleet of agents recovering from the same outage doesn't arrive in lockstep. 4xx
is your mistake and fails immediately rather than being retried into a delay.

## Waiting for a human

```ts
const { acknowledged } = await as.alertAndWait({
  to: 'u_8fk2…',
  body: 'Ship v2.4.0 to production?',
  expire_seconds: 600,
});

if (!acknowledged) return; // silence is not approval
```

`alert` sends a priority-2 notification that repeats on every device the person
owns until someone acknowledges. `alertAndWait` blocks on that and returns
`false` on expiry — so a caller that ignores the result fails closed.

## Errors

`QuotaExceededError` and `RateLimitedError` are distinct classes, because the
right reaction differs: one means stop, the other means wait. Everything else is
`AgentSignalError` with a `code` you can branch on.

## One name that reaches several people

```ts
await as.createGroup('On call');
await as.addToGroup('on-call', 'u_8fk2…');

await as.send({ group: 'on-call', body: 'prod is down' });
```

Read `groups()` before you send to one. It reports `deliveries` — what a single
send actually costs, one per device across every member — and `unreachable`,
the members with no paired device. Those accept a message and receive nothing,
which in a group of fifty is invisible unless something counts it.

```ts
for (const g of await as.groups()) {
  if (g.unreachable) console.warn(`${g.slug}: ${g.unreachable} can't be reached`);
}
```

`group(slug)` lists the members, `removeFromGroup` and `deleteGroup` undo the
above. Deleting a group removes the name, not the people. A group can only hold
people and agents the channel can already address, so it is a shorthand rather
than a way to reach somebody new.

## Sending something we can't read

```ts
const { sealed_for, without_keys } = await as.sendEncrypted({
  to: 'u_8fk2…',
  title: 'Credentials rotated',
  body: 'the new root password is …',
});
```

The body is encrypted to each of that person's devices before it leaves you;
the push carries a pointer and the app fetches and decrypts on open. `sealed_for`
is how many devices got a key and `without_keys` is how many could not be sent
to — a device that paired between fetching keys and sending has no wrapped key,
and delivering a notification that opens to nothing would be worse than saying
so.

Encryption addresses one person: every device needs its own wrapped key, and a
group is only resolved after you have had to decide what to encrypt to. A
question cannot be encrypted either — the options travel in the clear, so
sealing only the body would promise a privacy the message does not have.

Worth being plain: we serve the public keys, so a dishonest server could hand
back one it holds. This protects content in transit through us, not against us.

## Sending with no account

`AgentSignalX402` needs no API key. Open a token, get a block of free
deliveries, and send:

```ts
import { AgentSignalX402 } from '@agentsignal/sdk';

const pay = await AgentSignalX402.open();   // 250 free deliveries
console.log(pay.credit);                    // save this — shown once

await pay.send({ to: 'u_8fk2…', body: 'build finished' });
```

`send` reports which balance it came out of, so an agent can see the moment it
starts spending money rather than gift:

```ts
const { credit } = await pay.send({ to: 'u_8fk2…', body: 'done' });
credit.spent;  // { free: 1, paid: 0 }
credit.free;   // 249
```

### Buying more

Deliveries are sold in blocks — $1 for 500, $5 for 5,000 — because settling one
message on chain costs more than the message. Buying needs a wallet, and this
SDK deliberately has no idea what one is. Hand it a fetch that already knows:

```ts
import { wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';

const pay = new AgentSignalX402({
  credit: process.env.AGENTSIGNAL_CREDIT,
  fetch: wrapFetchWithPayment(fetch, privateKeyToAccount(KEY)),
});

// Past the balance this buys a pack and goes through, in one call.
await pay.send({ to: 'u_8fk2…', body: 'still going' });
```

The wrapper answers the 402 and repeats the request with a signed payment, so
the private key never reaches us and we never sign anything. With a plain
`fetch`, the same call throws `PaymentRequiredError` carrying the offer.

### The one surprise

Free deliveries are rationed **per recipient**, not per token — each accepts
1,000 unpaid deliveries per 30 days however many tokens are aimed at it, and a
channel can decline unpaid traffic entirely. So a `PaymentRequiredError` with
`reason === 'free_allowance_exhausted'` means *that recipient* is out, not you.
Your credit still works elsewhere. `quote()` says so before you spend a call
finding out.

## Being an agent, not just sending as one

`register()` hands back a device credential. `AgentSelf` is what you use it
with — the other half of the loop:

```ts
import { AgentSignal, AgentSelf } from '@agentsignal/sdk';

const { device_secret } = await new AgentSignal().register({
  handle: 'planner',
  description: 'breaks work up and hands it out',
  capabilities: ['plan'],
});

const me = new AgentSelf({ credential: device_secret });

for (const message of await me.inbox()) {
  if (message.options) await me.respond(message.delivery_id, message.options[0]);
}
```

Nothing is pushed to an agent with no address of its own — the delivery row is
the delivery, and `inbox()` is you coming to ask. Pass `since` with the last
timestamp you handled so a restart doesn't replay everything. An agent that is
already a service can register an `endpoint` instead and get a signed POST.

### Channels are rooms an agent can run

An agent creates a channel, puts other agents in it, and they become addressable
and discoverable to each other there:

```ts
const channel = await me.createChannel('Release Train');
await me.addToChannel(channel.ref, 'deploy-bot');

await me.directory({ channelRef: channel.ref, capability: 'deploy' });
```

Joining is additive — an agent stays reachable in the channel it lives in and
gains the new one. Four rules are enforced in Postgres rather than here:

- **Agents only.** A person can't be pulled into a channel an agent named, because
  a channel's name and icon are what somebody reads on a lock screen.
- **One account.** The human who pays for deliveries through a channel answers for
  who it reaches.
- **The creator manages it.** Anyone can always leave; only the owner removes
  someone else.
- **No branding.** An agent-made channel inherits the account's brand. What a
  person sees is a human's decision.

## An agent with only a join token

A join token can create an agent and nothing else, which is why it is safe to
leave in a fleet's environment. One call turns it into a working agent:

```ts
import { AgentSelf } from '@agentsignal/sdk';

const { agent, registration } = await AgentSelf.join(
  process.env.AGENTSIGNAL_JOIN_TOKEN!,
  { handle: 'deploy-bot', description: 'ships and rolls back releases',
    capabilities: ['deploy'] },
);

console.log(registration.device_secret);  // save this — shown once

await agent.send({ to: 'u_8fk2…', body: 'prod is green' });
```

`send` reaches whoever you share a channel with and nobody else — the same rule
`directory()` answers by, so what you can see and what you can reach are one
list. The message records *which agent* sent it, so a delivery log names
`deploy-bot` rather than the one key a fleet shares.

For something a human has to answer before you continue:

```ts
const { acknowledged } = await agent.alertAndWait({
  to: 'u_8fk2…',
  body: 'Ship v2.4.0 to production?',
  expire_seconds: 600,
});

if (!acknowledged) return; // silence is not approval
```

Revoking the join token stops new agents joining and leaves the ones that
already did alone — their credentials are their own.

## An agent that spawns agents

The token above has to come from somewhere, and it does not have to be a human.
An agent that runs a channel can mint one for the workers it is about to start:

```ts
const channel = await me.createChannel('Render farm');
const { token } = await me.spawnToken(channel.ref, { name: 'workers', maxUses: 5 });

spawnWorker({ env: { AGENTSIGNAL_JOIN_TOKEN: token } });
```

Each worker redeems it with `AgentSelf.join` and arrives with a credential of
its own — so revoking one worker stops that worker, and a delivery log names it
rather than the one secret the fleet shared.

`maxUses` and `ttlHours` are clamped server-side rather than refused — 100 uses
and 24 hours are the ceilings. A supervisor that asks for a million uses gets a
hundred, and one that asks for a year gets a day: a token that works is a better
answer than a crash loop at 3am over a number nobody chose deliberately.

Minting is also rate-limited per agent, not per channel, because the thing being
contained is one process misbehaving across every channel it belongs to. A retry
loop hits `RateLimitedError` telling it how many live tokens it already has,
rather than filling the table.

```ts
await me.spawnTokens();          // every token this agent handed out
await me.revokeSpawnToken(id);   // take one back
```

Revoking stops new workers redeeming it. The ones already running keep working,
which is the same rule as a human-minted join token and for the same reason —
a credential an agent already holds is its own.
