# quest-workflow

The unified hierarchical workspace extension. Replaces the
old asks/sidequests/issues/PR-notes substrate with a single
quest model: campaigns (quests), subquests under them and
free-standing sidequests, with plan, research, brief and
report documents living underneath.

## Tool

One tool, `quest`, with action verbs. Every verb below is
shipped and tested.

- **Lifecycle**: `create`, `load`, `unload`, `show`, `list`,
  `tree`, `expand`.
- **Document stage**: `think`, `draft`, `build`,
  `conclude`, `retire`, `focus`, `unfocus`.
- **Priority and rank**: `promote`, `demote`, `drive`,
  `park`, `defer`, `top`, `bottom`, `bump`, `sink`,
  `before`, `after`, `renumber`.
- **Structural edits**: `reparent` (single or comma-
  separated batch), bulk `conclude` / `retire` (triggered
  by a comma-separated `id` set), and `undo`. All
  structural edits are atomic, support a `dryRun` preview,
  and are journalled so `undo` can reverse the last one.
- **Aliases**: `alias-add`, `alias-remove`.
- **Sessions**: `session-attach`, `session-detach`,
  `session-rename`.
- **Working trees**: `tree-add`, `tree-list`, `tree-prune`,
  `tree-expand`.
- **Terminal spawn**: `spawn-tab`, `spawn-pane`,
  `spawn-window`.
- **Queries**: `find`, `who`, `links`.

Destructive verbs take typed parameters, not free-form
prose:

- `tree-prune` takes `force: true` to override safety
  refusals.

The `note` parameter is plain prose attached to a Journey
entry; it never triggers behaviour.

## What It Owns

- The loaded quest and focused document state.
- The stage machine for the focused document (subsumes the
  prior plan-workflow's stage machine, generalised across
  document kinds).
- Discipline: while a focused plan is in `think` or `draft`,
  code writes are blocked everywhere except the plan
  document itself.
- The status-bar widget showing the loaded quest, its kind,
  status, and the focused document's stage and progress.
- Auto-load on session start when the cwd is inside a
  quest's directory tree.

## What It Doesn't Own

- The on-disk format. That's the `quest-format` skill plus
  the `lib/quest/` library.
- The methodology. That's the `quest-convention` and
  `planning-guide` skills.
- URL fetching, people resolution and ref parsing. Those
  are the `lib/refs/`, `lib/people/` libraries.
- Terminal launching. That's `lib/terminal/`.

## Storage

Quest directories live under the `questsRoot`. The default
is `~/.local/share/pi/agentic-harness.pi/quest-workflow/quests/`
(per XDG); override it by setting `questsRoot` in the
`quest-workflow` section of the package config file at
`~/.config/pi/agentic-harness.pi/config.json`.

## Related Extensions

- `plan-workflow` has been retired. Its responsibilities
  (the stage machine, plan-doc scaffolding, the status-bar
  widget) live here now, with plans positioned as one of
  four document kinds under a quest.
- `pr-workflow` cooperates by writing PR review notes as
  research documents under a sidequest with `github-pr`
  aliases.
