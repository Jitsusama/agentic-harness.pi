# Plan Mode Extension

Read-only investigation mode for collaborative planning. When
it's active, tools are restricted so the agent can only read
code and write to the plan directory.

The [planning-guide skill](../../skills/planning-guide/) teaches
the methodology. This extension enforces the guardrails.

## Activation

The agent activates plan mode via the `plan_mode` tool when it
detects planning intent, after confirming with you. The skill
guides when to activate and deactivate.

You can also toggle plan mode manually:

| Method | Description |
|--------|-------------|
| `/plan` | Toggle plan mode |
| `Ctrl+Alt+P` | Toggle plan mode |
| `--plan` flag | Start session in plan mode |

## Worktree Isolation

When the agent provides a `repos` parameter during activation,
plan mode creates a git worktree in each listed repository so
implementation happens in isolated working trees. This prevents
collisions when multiple pi sessions operate on the same
repository. Use `"."` for the current repo, or absolute paths
for additional repositories the plan will touch.

Worktrees are created at each repo's current HEAD. Branch
creation happens later, during implementation, following the
`git-branch-convention` skill. All worktrees for the same plan
share a timestamp-based name so they're identifiable as a group.

Planning stays in the main tree (read-only investigation doesn't
need isolation). When the plan is written and you choose to
implement, the agent receives the worktree paths and the
absolute path to the plan file. It cds into each worktree to
implement.

The `/plan` command and `Ctrl+Alt+P` shortcut activate without
worktrees. Use the `plan_mode` tool with a `repos` parameter
for worktree isolation.

Worktree cleanup is manual: the generated plan includes a
cleanup section with the commands to remove the worktrees and
branches after the work is merged or abandoned.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode on/off |
| `/plan-dir [path]` | Show or set the plan output directory |

## Configuration

Plans are written to `.pi/plans/` by default. You can override
this with `/plan-dir <path>` or in `.pi/settings.json`:

```json
{ "planDir": "docs/plans" }
```
