# Slack Library

Slack API client, authentication, renderers and resolvers for
Pi extensions.

The API client, renderers, resolvers, credential storage and error
formatting are pi-agnostic and live in `agentic-harness.core`'s
`slack` library; this package re-exports all of it. The one thing
that stays here is `ensureAuthenticated`: the interactive setup
wizard and OAuth web redirect flow need Pi's UI to run.

## Getting Started

```typescript
import {
  ensureAuthenticated,
  searchMessages,
  renderMessageList,
} from "agentic-harness.pi/slack";

// One call to authenticate (runs interactive flow if needed).
const client = await ensureAuthenticated(ctx, {
  clientId: process.env.SLACK_CLIENT_ID ?? "",
  clientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
});

// Use the client with any API function.
const results = await searchMessages(client, { query: "in:#general" });
const rendered = renderMessageList(results.messages);
```

## Sub-Modules

- **`agentic-harness.core/slack`**: `SlackClient` and every API,
  renderer and resolver function, plus credential state readers
  (`hasToken`, `getToken`) and `formatAuthError`. Deeper subpaths
  (`.../slack/auth/oauth`, `.../slack/auth/browser`, etc.) exist for
  the pieces the setup wizard needs directly.
- **`./auth`**: `ensureAuthenticated`, the one-call entry point that
  bridges the setup wizard and the OAuth web redirect flow through
  Pi's interactive UI.
