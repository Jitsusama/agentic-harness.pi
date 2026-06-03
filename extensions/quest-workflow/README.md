# quest-workflow

The unified hierarchical workspace extension. Replaces the
old asks/sidequests/issues/PR-notes substrate with a single
quest model: campaigns (quests), subquests under them and
free-standing sidequests, with plan, research, brief and
report documents living underneath.

## Tool

One tool, `quest`, with action verbs:

- **Lifecycle**: `create`, `load`, `unload`, `show`, `list`.
- **Document stage**: `think`, `draft`, `build`, `conclude`,
  `retire`, `focus`, `unfocus`.

(More verbs are planned but not yet wired: importance
reordering, alias linking, session attach/detach, terminal
spawn, find with time-range filters, who, links.)

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
(per XDG); override with the `QUEST_WORKFLOW_ROOT` environment
variable.

## Related Extensions

- `plan-workflow` has been retired. Its responsibilities
  (the stage machine, plan-doc scaffolding, the status-bar
  widget) live here now, with plans positioned as one of
  four document kinds under a quest.
- `pr-workflow` cooperates by writing PR review notes as
  research documents under a sidequest with `github-pr`
  aliases.
