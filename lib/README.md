# Library

Reusable TypeScript code for Pi extensions. Other Pi packages
can add this repo as an npm dependency and import from the
public modules without loading any extensions or skills.

## Public Modules

Each public module has a barrel export (`index.ts`) that
defines the importable surface. Import from the barrel, not
from internal files.

- **[`ui/`](ui/)** — TUI primitives: panels, prompts, content
  rendering, navigable lists and text layout.
- **[`slack/`](slack/)** — Slack API client, authentication,
  renderers and resolvers.
- **[`google/`](google/)** — Google Workspace API clients,
  authentication and renderers.

## Internal Modules

[`internal/`](internal/) contains code shared across
extensions in this package. It has no barrel exports and is
not part of the public surface. Don't import from it in
external packages; it may change without notice.
