# Google Workspace Library

Google Workspace API clients, authentication and renderers for
Pi extensions. Covers Gmail, Calendar, Drive, Docs, Sheets and
Slides. Designed for use within Pi; the auth flow uses Pi's
interactive UI.

## Getting Started

```typescript
import {
  ensureAuthenticated,
  listEvents,
  renderEventList,
} from "agentic-harness.pi/google";

// One call to authenticate (runs interactive flow if needed).
const client = await ensureAuthenticated(ctx, {
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
});

// Use the client with any API function.
const events = await listEvents(client, { start: "today" });
const rendered = renderEventList(events);
```

## Sub-Modules

Each subdomain has its own barrel for fine-grained imports:

- **`apis/`** — API functions for all six Google services.
- **`auth/`** — `ensureAuthenticated` (one-call entry point),
  credential state readers (`getCredentials`,
  `getDefaultAccount`, `listAccounts`).
- **`renderers/`** — markdown formatting for Google entities.
