# agentic-harness.pi

A [pi](https://github.com/badlogic/pi-mono) package that adds
collaborative coding workflows: planning, TDD, git hygiene,
code investigation and PR authoring.

## Install

```bash
pi install git:github.com/Jitsusama/agentic-harness.pi
```

Or give it a try without installing:

```bash
pi -e git:github.com/Jitsusama/agentic-harness.pi
```

## How It Works

This package has two layers:

**[Skills](skills/)** teach the agent *how* to work: planning
methodology, TDD discipline, commit conventions and so on.
They're guidance the agent follows voluntarily when a task
matches.

**[Extensions](extensions/)** enforce *guardrails*: gating
commits for review, restricting tools in read-only mode,
enforcing TDD phases and vetting PR comments before they're
posted.

Skills and extensions complement each other but work
independently. You can use skills without extensions (guidance
only), extensions without skills (enforcement only), or both
together for the full workflow. Some are paired; the skill
teaches the methodology and the extension enforces it. Each
has its own README with details.

## Composability

Every piece works independently. Mix and match:

- **Skills only**: the agent follows guidance voluntarily.
- **Extensions only**: enforcement without any skills.
- **Both together**: plan → TDD → commit flows seamlessly.

Use [package filtering](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#package-filtering)
to load only what you want. For example, if you just want
the TDD workflow:

```json
{
  "packages": [
    {
      "source": "git:github.com/Jitsusama/agentic-harness.pi",
      "extensions": ["extensions/tdd-mode"],
      "skills": ["skills/tdd-workflow"]
    }
  ]
}
```

## Library

The [`lib/`](lib/) directory provides reusable TypeScript code
that other Pi packages can import without loading any of this
package's extensions or skills. Add this repo as a dependency:

```json
{
  "dependencies": {
    "agentic-harness.pi": "github:Jitsusama/agentic-harness.pi"
  }
}
```

Then import from the public modules:

```typescript
import { promptSingle, renderMarkdown } from "agentic-harness.pi/ui";
import { ensureAuthenticated, searchMessages } from "agentic-harness.pi/slack";
import { ensureAuthenticated, listEvents } from "agentic-harness.pi/google";
```

Three public libraries are available:

- **[`lib/ui/`](lib/ui/)** — TUI primitives: panels, prompts,
  content rendering, navigable lists and text layout.
- **[`lib/slack/`](lib/slack/)** — Slack API client,
  authentication, renderers and resolvers.
- **[`lib/google/`](lib/google/)** — Google Workspace API
  clients, authentication and renderers.

Everything in `lib/internal/` is not part of the public
surface and may change without notice.

## Project-Local Overrides

Each project can layer on its own configuration via `.pi/`:

```markdown
<!-- .pi/AGENTS.md -->
Test command: `cargo test`
Commit scopes for this project: api, cli, core, db
```

```json
// .pi/settings.json
{ "planDir": "docs/plans" }
```

## Licence

[MIT](LICENSE)
