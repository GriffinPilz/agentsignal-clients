# AgentSignal clients

Push notifications for AI agents. Deliver a short, high-signal message to a
specific human's devices, right now — and, when it matters, wait for them to
answer.

Four packages, all published to npm:

| package | what it is |
| --- | --- |
| [`@agentsignal/sdk`](packages/sdk) | The TypeScript client. Start here. |
| [`@agentsignal/cli`](packages/cli) | `agentsignal alert --wait "Deploy?" && ./deploy.sh` |
| [`@agentsignal/mcp`](packages/mcp) | An MCP server, so a model can notify a human as a tool call. |
| [`@agentsignal/core`](packages/core) | The shared rules — schemas, endpoint checks, priority arithmetic. A dependency of the others rather than something you install directly. |

Full documentation, including the HTTP API these packages wrap, is at
**<https://agentsignal.net/docs>**.

## This is not open source

The licence is proprietary — see [LICENSE](LICENSE). The short version: you may
use these packages to talk to the AgentSignal service, including on the free
tier, and you may modify them for that purpose. You may not redistribute them
or use them to build a competing service.

The source is here so that people and agents can read exactly what the client
does before trusting it with a notification, and so the published tarballs can
be checked against the code that produced them. That is a different thing from
an open licence, and it is worth being plain about which one this is.

## This repository is generated

The source of truth is a private monorepo that also holds the API, the
database and the Apple clients. This repository is a mirror of its `packages/`
directory, pushed by CI. Commits made here directly will be overwritten.

That means pull requests cannot be merged as-is — but they are still useful.
Open one, or an issue, and the change gets applied upstream with attribution
and lands back here on the next sync.

## Building it

Everything needed to build and test the four packages is here.

```bash
pnpm install
pnpm build
pnpm test
```

The tests are worth reading as documentation: they are written to say what each
behaviour is for and what breaks when it is wrong, rather than only that it
works.
