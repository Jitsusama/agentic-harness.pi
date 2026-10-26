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
  `tree`, `expand`, `reopen`, `reclassify`.
- **Document stage**: `think`, `draft`, `build`,
  `conclude`, `retire`, `focus`, `unfocus`. `draft` accepts a
  `kind` override to correct a document kind before its id is
  minted.
- **Priority and rank**: `promote`, `demote`, `drive`,
  `park`, `defer`, `top`, `bottom`, `bump`, `sink`,
  `before`, `after`, `renumber`.
- **Structural edits**: `reparent` (single or comma-
  separated batch), bulk `conclude` / `retire` (triggered
  by a comma-separated `id` set), and `undo`. All
  structural edits are atomic and journalled so `undo` can
  reverse the last one. `reparent` and the sweep take a
  `dryRun` preview; `undo` has none, and given one it
  refuses and says what it would reverse. Every session
  shares the one journal, so `undo` needs the `id` of a
  quest the last change touched, and refuses otherwise.
- **Dry runs**: an action that can't preview refuses
  `dryRun: true` and does nothing, rather than dropping it
  and acting for real. That includes `conclude` and
  `retire` of the loaded quest or a document, which only
  the sweep previews. The list of actions that preview is
  in `dry-run.ts`.
- **Aliases**: `alias-add`, `alias-remove`.
- **Sessions**: `session-attach`, `session-detach`,
  `session-rename`, `session-audit` (report any session active on
  more than one quest).
- **Working trees**: `tree-add`, `tree-adopt`, `tree-list`,
  `tree-prune`, `tree-expand`. `tree-add` scaffolds a fresh
  worktree the quest owns and auto-prunes on conclude; `tree-adopt`
  registers an existing tree the quest only references and never
  auto-prunes. Both accept a `cwd` parameter, so you scaffold or
  adopt from any session without changing its directory: point
  `cwd` at the repo to scaffold from, or at a path inside the tree
  to adopt. `tree-prune` and `tree-expand` take `cwd` the same way,
  as a path inside the tree to act on; with several trees on the
  quest they refuse rather than pick one, and a path that names
  none of them is refused with the list.
- **Terminal spawn**: `spawn`, `spawn-tab`, `spawn-pane`,
  `spawn-window`, and `restore` with `force`. Each takes
  `terminal`, `layout` and `nesting` for the call and
  `dryRun` to see the decision without opening anything;
  otherwise the person's `terminal` settings decide, by
  quest, by project or by default, and the answer names the
  layer that chose. The command is typed into a login shell
  so the person's startup files put the right pi on PATH.
  Restore gathers tabs with no window to hold them into one
  new window, and counts a session reopened only once its pi
  has started. A lost session pi never saved, since it was
  lost before its first message, has nothing to resume:
  restore starts a fresh pi on its quest in its folder
  instead, says so, and stops offering it once a session is
  running in its place. See the terminal library's README for
  the settings.
- **Queries**: `find`, `who`, `links`, `locate` (the inverse
  index: resolve a document id, alias ref or session id to the
  quest that owns it), `ancestors` (trace a quest's parent chain
  up to the root), `workspace` (the quests being worked on right
  now, those with a live or recently active session).

Destructive verbs take typed parameters, not free-form
prose:

- `tree-prune` takes `force: true` to override safety
  refusals.

The `note` parameter is plain prose attached to a Journey
entry; it never triggers behaviour.

Quest calls run one at a time, even when pi runs a batch of
tool calls concurrently: every verb reads the quest, waits on
something, then writes it back, and two interleaved calls would
each act on what the other had already changed. A call stopped
while it waits its turn leaves without running.

## What It Owns

- The loaded quest and focused document state.
- The stage machine for the focused document (subsumes the
  prior plan-workflow's stage machine, generalised across
  document kinds).
- Discipline: a classification gate over every write, edit
  and bash redirect. While a focused plan is in `think` or
  `draft`, only edits to already-tracked code in the
  quest's trees defer to build, or in any tree while the
  quest tracks none. In `build`, writes flow inside any tree
  the quest tracks, into any quest's record and into any
  quest's workspace; a write inside an untracked git tree
  adopts that tree and goes ahead, and a homeless write is
  refused with `tree-add`. Across stages, `/dev` nodes
  always flow. The agent's commands run with `TMPDIR` set
  to `/tmp/pi-quest-<ID>`, a link to the loaded quest's workspace
  `tmp/`, which conclude and retire clear; a path named in
  system temp is refused with that remedy. Bash targets resolve as the shell
  would, so `~` is the home directory and a `cd` counts.
- Sharing the machine by quest: the agent's commands and
  subagents carry `PI_QUEST`, the loaded quest's id, and on
  Linux every session keeps `$XDG_RUNTIME_DIR/jobs/quests.json`,
  each open quest's id to a cgroup weight by its priority
  (driving 400, active 200, queued 100, bench 50, someday 25),
  rewritten at session start and after a quest action when it
  would change. A machine that sorts work into a cgroup per
  quest reads both; elsewhere nothing reads them.
- Edits to a document's body: `journal` adds a dated
  Journey entry, to the quest `id` names or else the loaded
  one, at the head of its `attachments/journey.md` (the
  README's Journey section only points there; until the core
  fold, entries core's verbs append to the README are swept
  into the file after each quest action), `tick` and `untick` set a checkbox item by
  its text or a unique start of it, and `section` replaces
  one `##` section. Each reads and writes under the quest
  lock and leaves the front matter byte for byte, since the
  workflow rewrites these files between a hand edit's read
  and its write. A hand edit that changes a field the
  workflow owns (a document's `stage`, `id`, `kind` or
  `quest`, a quest's `id`, `kind` or `status`) is refused
  with the verb that changes it.
- The gates are guards under the guard policy:
  `quest-record`, `quest-owned-fields` and
  `quest-plan-stage` block. `quest-temp` and
  `quest-homeless` redirect: the agent hears the refusal
  and its remedy, and the same write made again goes
  through as an override you see. Each path those let
  through, outside every tree, is noted in the quest's
  workspace (`outside-writes.jsonl`), and `conclude` names
  them in its message and Journey, so a quest accounts for
  everything it touched. `quest-untracked-tree`
  redirects by adopting the tree. A
  main checkout cannot be adopted without force, so a write
  into one goes ahead untracked, said once per session.
  `/guards quest-untracked-tree block` restores the refusal
  with `tree-adopt` guidance. See
  [guard-policy-workflow](../guard-policy-workflow/README.md).
- The quest's one line above the editor: its kind and status
  glyphs, its title, the focused document's stage, the step
  count and the next item, with the quest id right-aligned and
  dimmed. Short of room, the next item goes first, then the
  document, then the title shortens; the glyphs, the step count
  and the id always stay.
- Auto-load on session start when the cwd is inside a
  quest's directory tree.
- Telling the model which quest and document it is on. The
  line is frozen into the system prompt the first time a
  session renders it, and a later load, focus or stage change
  is said once as an appended message, so a quest action
  never rewrites the cached conversation. What was frozen and
  last said is persisted, so a reload renders the same bytes;
  a compaction resets it so a changed state is said again.

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
- There used to be a bridge here, `lib/quest/pr-bridge.ts`,
  that let a review tool write notes under a sidequest found
  by a `github-pr` alias. It went with `pr-workflow`, which
  was its only consumer, though not at the same time: it
  outlived that deletion by a week with a producer and no
  reader, kept alive by its own tests.

  It is worth saying why it was not generalized instead. Its
  whole vocabulary was a PR: `findOrCreateSidequestForPr`
  took an owner, a repo and a number, which cannot name a
  change on a system that has none of the three. Widening a
  shape built around one backend is how the substrate came to
  exist in the first place. If quest footprints from review
  rounds are wanted again, they should be built against a
  change reference and its label, and the alias type should
  come from the provider that claimed it.
