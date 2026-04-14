# Library

Reusable TypeScript code for Pi extensions. Other Pi packages
can add this repo as an npm dependency and import from the
public modules without loading any extensions or skills.

## Public Modules

Each public module has a barrel export (`index.ts`) that
defines the importable surface. Import from the barrel, not
from internal files.

- **[`guardian/`](guardian/)** — Guardian contract,
  registration and redirect formatting. Everything a
  downstream package needs to build its own command guardians.
- **[`shell/`](shell/)** — Shell command parsing: flag
  extraction, heredoc stripping, compound command splitting
  and safe quoting.
- **[`ui/`](ui/)** — TUI primitives: panels, prompts, content
  rendering, navigable lists and text layout.
- **[`slack/`](slack/)** — Slack API client, authentication,
  renderers and resolvers.
- **[`google/`](google/)** — Google Workspace API clients,
  authentication and renderers.
- **[`web/`](web/)** — Web search and page reading via
  headless Chrome.

## Internal Modules

[`internal/`](internal/) contains code shared across
extensions in this package. Don't import from it in external
packages; it may change without notice.

The general-purpose guardian and shell parsing code was
promoted from `internal/guardian/` to the public `guardian/`
and `shell/` modules. The internal directory retains only
commit-specific parsing and the entity review helper.
