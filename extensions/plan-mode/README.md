# Plan Mode Extension

Read-only investigation mode for collaborative planning. When
active, tools are restricted so the agent can only read code
and write to the plan directory.

The [plan-workflow skill](../../skills/plan-workflow/) teaches the
methodology. This extension enforces the guardrails.

## Activation

The agent activates plan mode via the `plan_mode` tool when it
detects planning intent, after confirming with the user. The
skill guides when to activate and deactivate.

Plan mode can also be toggled manually:

| Method | Description |
|--------|-------------|
| `/plan` | Toggle plan mode |
| `Ctrl+Alt+P` | Toggle plan mode |
| `--plan` flag | Start session in plan mode |

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode on/off |
| `/plan-dir [path]` | Show or set the plan output directory |

## Configuration

Plans are written to `.pi/plans/` by default. Override with
`/plan-dir <path>` or in `.pi/settings.json`:

```json
{ "planDir": "docs/plans" }
```
