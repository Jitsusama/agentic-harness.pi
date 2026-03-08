# Extensions

Extensions enforce guardrails around the agent's actions. Where
[skills](../skills/) teach the agent what to do, extensions gate
and validate what actually happens.

## Categories

### Guardians

Intercept and gate actions before execution — approve, edit,
steer, or reject.

| Extension | Description |
|-----------|-------------|
| [commit-guardian](commit-guardian/) | Commit message review with validation indicators |
| [history-guardian](history-guardian/) | Destructive command protection (force-push, hard reset, etc.) |
| [pr-guardian](pr-guardian/) | PR description review before `gh pr create/edit` |
| [issue-guardian](issue-guardian/) | Issue description review before `gh issue create/edit` |

### Modes

Stateful workflow enforcement, toggled on/off.

| Extension | Description |
|-----------|-------------|
| [plan-mode](plan-mode/) | Read-only investigation mode for collaborative planning |
| [tdd-mode](tdd-mode/) | Red → green → refactor state machine with phase enforcement |

### Tools

Register new agent capabilities.

| Extension | Description |
|-----------|-------------|
| [ask](ask/) | Structured question tool for clarifying requirements |
| [pr-review](pr-review/) | Inline PR review comments with human vetting |
| [web-search](web-search/) | Web search and page reading via headless Chrome |
| [content-viewer](content-viewer/) | Scrollable file/diff/markdown viewer (`/view` command) |

### UI

Display components.

| Extension | Description |
|-----------|-------------|
| [status-line](status-line/) | Responsive single-line footer with directory, model, context, and thinking level |

## Shared Utilities

The [shared](shared/) directory contains common components used
across extensions. See [shared/README.md](shared/README.md) for
details.
