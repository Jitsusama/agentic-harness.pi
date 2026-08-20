# Google Workspace Library

Google Workspace API clients, authentication and renderers for
Pi extensions. Covers Gmail, Calendar, Drive, Docs, Sheets and
Slides.

The API clients, renderers, credential storage and error formatting
are pi-agnostic and live in `agentic-harness.core`'s `google`
library; this package re-exports all of it. The one thing that
stays here is `ensureAuthenticated`: the interactive setup wizard
and device/web OAuth flow need Pi's UI to run.

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

- **`agentic-harness.core/google`**: API functions for all six
  Google services, renderers, and credential state readers
  (`getCredentials`, `getDefaultAccount`, `listAccounts`) plus
  `formatAuthError`. Deeper subpaths (`.../google/auth/oauth`,
  `.../google/auth/browser`, etc.) exist for the pieces the setup
  wizard and device/web flow need directly.
- **`./auth`**: `ensureAuthenticated`, the one-call entry point that
  bridges the setup wizard and the device/web OAuth flow through
  Pi's interactive UI.
