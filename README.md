# agentic-harness.pi

Turn [pi](https://github.com/badlogic/pi-mono) into a
disciplined pair programmer. This package gives the agent the
habits of a good teammate: it plans before it builds, works
test-first, keeps git and GitHub history clean, reviews pull
requests like a careful reviewer, and reaches for Slack, Gmail,
the web and your language server when the task calls for it.

Nothing here is magic and nothing is all-or-nothing. Every
piece works on its own, so you can adopt one habit today and
another next week.

## Install

```bash
pi install git:github.com/Jitsusama/agentic-harness.pi
```

Or take it for a spin without installing:

```bash
pi -e git:github.com/Jitsusama/agentic-harness.pi
```

## How It Works

The package has two layers that complement each other.

**[Skills](skills/)** teach the agent *how* to work: planning
methodology, TDD discipline, commit and PR conventions, a
writing voice, and how to drive each tool. They are guidance
the agent follows when a task matches, and it can decline them.

**[Extensions](extensions/)** enforce *guardrails* and add
*capabilities*: they gate a commit for your review, hold the
agent to the TDD phases, vet a PR comment before it posts, and
hand the agent tools it would not otherwise have, like a real
language server or a browser.

Skills teach; extensions enforce and enable. Some are paired,
the skill explaining a method and the extension holding the
line on it, but each stands alone. Use skills without
extensions for guidance only, extensions without skills for
enforcement only, or both for the full workflow.

## What's Inside

A quick tour of the surface. Each extension and skill has its
own README with the details.

**Plan the work.** The `quest-workflow` extension gives the
agent a hierarchical workspace of quests, subquests and
sidequests, each with living plan, research and report
documents that survive across sessions. The `planning-guide`
skill teaches the collaborative think-draft-build method behind
it, and `ask-workflow` lets the agent ask you a structured
question when it is genuinely blocked.

**Build test-first.** The `tdd-workflow` extension tracks the
red-green-refactor loop and reminds the agent where it is;
`code-tdd-guide` teaches the method. When an edit lands,
`verification-workflow` runs the right check and closes the
trust gap, and `code-style-standard` keeps the code readable.

**Keep history clean.** A family of guardians gates the
irreversible moments for your review: `commit-guardian`,
`pr-guardian`, `issue-guardian` and `history-guardian`.
Interceptors quietly enforce convention as the agent types:
`attribution-interceptor`, `git-cli-interceptor` and
`github-cli-interceptor`. The matching skills (`commit-format`,
`git-commit-convention`, the `github-*` conventions and more)
teach the rules the gates hold.

**Review pull requests.** The `pr-workflow` extension runs a
conversation-first, multi-model review: a council of reviewers
fans out, a judge consolidates, an optional critique round
pushes back, and you synthesize before anything posts.
`pr-workflow-guide` teaches the tool, `code-review-standard`
the evaluation criteria and `comment-format` the comment shape.

**Understand the code.** The `lsp-integration` extension gives
the agent real semantic intelligence, definitions, references,
diagnostics and safe renames, from your project's language
server. `code-investigation-guide` teaches how to explore a
codebase before changing it, and `subagent-workflow` fans work
out to N pi subagents for multi-angle investigation.

**Remember and improve.** `memory-integration` gives the agent
durable, quest-scoped memory so it stops re-onboarding.
`correction-capture` turns the steering you do into durable
rules, `convention-context` keeps the authoring rules resident,
and the `advisor` extension puts a second model over the
agent's shoulder to raise evidence-backed notes.

**Reach the outside world.** Integrations add AI-friendly
access to real services: `google-workspace-integration` for
Gmail, Calendar, Drive, Docs, Sheets and Slides;
`slack-integration` for Slack; `web-search-integration` for
searching and reading the web; and `browser-integration` for
driving a real browser.

**Live in the terminal.** Widgets round out the experience:
`content-viewer-widget`, `mermaid-widget`, `panel-zoom-widget`
and `status-line-widget`. And `observability-workflow` records
run telemetry for subagent and council fan-outs so you can see
what a run did and what it cost.

Browse [`extensions/`](extensions/) and [`skills/`](skills/)
for the complete list.

## Composability

Every piece works independently. Mix and match:

- **Skills only**: the agent follows guidance voluntarily.
- **Extensions only**: enforcement and capability without any
  skills.
- **Both together**: plan, TDD, review and commit flow
  seamlessly.

Use [package filtering](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#package-filtering)
to load only what you want. For example, to take just the TDD
workflow:

```json
{
  "packages": [
    {
      "source": "git:github.com/Jitsusama/agentic-harness.pi",
      "extensions": ["extensions/tdd-workflow"],
      "skills": ["skills/code-tdd-guide"]
    }
  ]
}
```

## Library

The [`lib/`](lib/) directory is reusable TypeScript that other
pi packages can import without loading any extension or skill.
Add this repo as a dependency:

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
import { webSearch, readPage } from "agentic-harness.pi/web";
```

The most-used public modules:

- **[`ui`](lib/ui/)** provides TUI primitives: panels,
  prompts, content rendering, navigable lists and text layout.
- **[`slack`](lib/slack/)** wraps the Slack API with
  authentication, renderers and resolvers.
- **[`google`](lib/google/)** wraps the Google Workspace APIs
  with authentication and renderers.
- **[`web`](lib/web/)** does web search and page reading via
  headless Chrome.

More is exported for building your own workflows: `guardian`
(the detect-parse-review contract for command gates), `shell`
(shell command parsing), `quest` and `tree` (the quest and
working-tree models), `subagent` (fan out pi subagents), `mcp`
(an MCP client), and `people`, `refs` and `terminal`. See the
`exports` map in [`package.json`](package.json) for the full
set.

Everything under `lib/internal/` is not part of the public
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
