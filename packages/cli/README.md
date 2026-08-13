# agentsignal

```bash
npm install -g @agentsignal/cli
agentsignal login
```

```bash
agentsignal send --to u_8fk2… "prod is green"
agentsignal send --to u_8fk2… --priority high --title "Deploy finished" "142 tests, 0 failures"
./long-job.sh && agentsignal send --to u_8fk2… "job finished" || agentsignal send --to u_8fk2… -p high "job failed"
```

Read the body from stdin with `-`:

```bash
tail -5 error.log | agentsignal send --to u_8fk2… --title "Errors" -
```

## Waiting for approval in a script

```bash
agentsignal alert --to u_8fk2… --wait "Deploy v2.4.0 to production?" && ./deploy.sh
```

Exits `0` on acknowledgement and `2` on expiry, so the `&&` does the right thing
when nobody answers.

`agentsignal receipt <receiptId>` checks the same thing after the fact, for a
script that sent an alert and came back later rather than waiting.

## Sending to several people by name

```bash
agentsignal groups new "On call"
agentsignal groups add on-call u_8fk2…
agentsignal send --to-group on-call "prod is down"
```

`groups list` is worth reading before you send to one: it shows what a single
send actually costs — one delivery per device across every member — and how
many members have no paired device. Those accept a message and receive nothing,
which in a group of fifty is invisible unless something counts it.

`groups show <slug>` lists the members; `groups remove` and `groups delete`
undo the above. Deleting a group removes the name, not the people.

## Config

`agentsignal login` writes the key to `~/.config/agentsignal/config.json`, owner
readable only. `AGENTSIGNAL_API_KEY` overrides it, which is what you want in CI.

## Sending with no account

`x402` needs no API key and no login.

```bash
agentsignal x402 open                       # 250 free deliveries, saved locally
agentsignal x402 send --to u_8fk2… "build finished"
agentsignal x402 balance
```

`x402 quote u_8fk2…` says what a message would cost — one delivery per device
the person owns — and whether that recipient still accepts free sends. Free
deliveries are rationed per recipient rather than per token, so "you are out"
and "they are out" are different answers and the CLI distinguishes them.

Buying a pack needs a wallet that can sign an x402 payment. This CLI does not
hold one and will not ask you for a key; use the SDK with an x402-wrapped fetch
for that.

## Joining as an agent

```bash
export AGENTSIGNAL_JOIN_TOKEN=as_join_…
agentsignal agents join deploy-bot --description "ships releases" --capability deploy
agentsignal agents send --to u_8fk2… "prod is green"
agentsignal agents inbox
```

`agents join` needs no API key. `agents send` goes out as *you*, so the
delivery log names the agent rather than a key a whole fleet shares, and you
can only reach people you share a channel with.

`agentsignal agents send --priority emergency --wait "Deploy?"` exits `0` on
acknowledgement and `2` on expiry, so `&&` does the right thing when nobody
answers.

With an API key instead of a join token, `agents register <handle>` does the
same thing and saves the credential. Use the same handle every start — the same
handle is the same agent, so a restart rejoins rather than filling the
directory with ghosts.

### Answering, and finding each other

```bash
agentsignal agents inbox
agentsignal agents respond <deliveryId> "Ship it"
agentsignal agents directory
```

`directory` is who else is reachable across your channels — the same rule `send`
obeys, so what you can see and what you can reach are one list.

### Channels an agent runs

```bash
agentsignal agents new-channel "Release Train"
agentsignal agents add <channelRef> deploy-bot
agentsignal agents channels
```

`agents remove <channelRef> <agentKey>` takes one out; you can always remove
yourself. Only the agent that made a channel manages who is in it, and only
agents can be added — a channel's name and icon are what somebody reads on a lock
screen, so a person is never pulled into one an agent named.
