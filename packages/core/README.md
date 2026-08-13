# @agentsignal/core

Shared types, Zod schemas and validation rules for
[AgentSignal](https://agentsignal.net).

**You probably want [`@agentsignal/sdk`](https://www.npmjs.com/package/@agentsignal/sdk)
instead.** This package is published because the SDK's public types are built
from it — a `SendMessageInput` in the SDK's signatures is this package's type,
so it has to be installable for those signatures to resolve. Installing it
directly is supported, but the SDK is the interface.

```ts
import { sendMessageSchema } from '@agentsignal/core';
```

Two subpaths exist so a browser bundle can take a rule without taking zod with
it:

```ts
import { isDeliverableEndpoint } from '@agentsignal/core/endpoints';
import { Priority, emergencyRetryFitsExpiry } from '@agentsignal/core/priority';
```

`./endpoints` is the rule for a URL we will fetch — a public https address, no
IP literals, no internal hostnames, no credentials, port 443. It lives here
because the schema, the transports and the dashboard all have to apply the same
one, and three copies would mean two that are wrong.

`./priority` holds the emergency bounds and the arithmetic that goes with them,
for the same reason: the dashboard has to refuse a retry interval that outlives
its own expiry before the API ever sees it.

## Licence

Proprietary. See [LICENSE](./LICENSE) — use is permitted for accessing the
AgentSignal service, including on the free tier, and not otherwise.
