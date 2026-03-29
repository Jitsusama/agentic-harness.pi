# Slack Library

Slack API client, authentication, renderers and resolvers for
Pi extensions. Designed for use within Pi; the auth flow uses
Pi's interactive UI.

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

Each subdomain has its own barrel for fine-grained imports:

- **`api/`** — `SlackClient` and all API functions (messages,
  channels, reactions, search, users).
- **`auth/`** — `ensureAuthenticated` (one-call entry point),
  credential state readers (`hasToken`, `getToken`).
- **`renderers/`** — markdown formatting for Slack entities.
- **`resolvers/`** — channel, user and conversation resolution.
