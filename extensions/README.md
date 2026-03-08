# Extensions

Extensions enforce guardrails around the agent's actions. Where
[skills](../skills/) teach the agent what to do, extensions gate
and validate what actually happens.

## Included Extensions

| Extension | Description |
|-----------|-------------|
| [ask](ask/) | Structured question tool for clarifying requirements |
| [git-guardian](git-guardian/) | Commit review and destructive command protection |
| [plan-mode](plan-mode/) | Read-only investigation mode for collaborative planning |
| [pr-review](pr-review/) | Inline PR review comments with human vetting |
| [status-line](status-line/) | Responsive single-line footer with directory, model, context, and thinking level |
| [tdd-mode](tdd-mode/) | Red → green → refactor state machine with phase enforcement |
| [web-search](web-search/) | Google search and page reading via headless Chrome |

## Shared Utilities

The [shared](shared/) directory contains common UI components used
across extensions — the approval gate and session state helpers.
