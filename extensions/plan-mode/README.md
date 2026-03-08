# Plan Mode Extension

Read-only investigation mode for collaborative planning. When
active, tools are restricted so the agent can only read code
and write to the plan directory.

The [plan-workflow skill](../../skills/plan-workflow/) teaches the
methodology. This extension enforces the guardrails.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode on/off |
| `/plan-dir [path]` | Show or set the plan output directory |

## Keyboard Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |

## Configuration

Plans are written to `.pi/plans/` by default. Override with
`/plan-dir <path>` or in `.pi/settings.json`:

```json
{ "planDir": "docs/plans" }
```
