# Google Workspace Library

Google Workspace API clients, authentication and renderers for
Pi extensions. Covers Gmail, Calendar, Drive, Docs, Sheets and
Slides.

It holds the API clients, renderers, credential storage and error
formatting, and `ensureAuthenticated`, which runs the interactive
setup wizard and the device or web OAuth flow in Pi's UI.

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

- **`./apis`** and **`./renderers`**: API functions for all six
  Google services, and how their answers are shown.
- **`./auth`**: credential state readers (`getCredentials`,
  `getDefaultAccount`, `listAccounts`), `formatAuthError`, and
  `ensureAuthenticated`, the one-call entry point that bridges the
  setup wizard and the device or web OAuth flow through Pi's
  interactive UI. The OAuth client, callback server and browser
  opener beside it are what that flow is built from.
