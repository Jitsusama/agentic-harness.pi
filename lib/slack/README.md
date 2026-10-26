# Slack Library

Slack API client, authentication, renderers and resolvers for
Pi extensions.

It holds the API client, renderers, resolvers, credential storage
and error formatting, and `ensureAuthenticated`, which runs the
interactive setup wizard and the OAuth web redirect flow in Pi's UI.

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

- **`./api`**, **`./renderers`** and **`./resolvers`**:
  `SlackClient` and every API, renderer and resolver function.
- **`./auth`**: credential state readers (`hasToken`, `getToken`),
  `formatAuthError`, and `ensureAuthenticated`, the one-call entry
  point that bridges the setup wizard and the OAuth web redirect flow
  through Pi's interactive UI. The OAuth exchange, callback server and
  browser opener beside it are what that flow is built from.
