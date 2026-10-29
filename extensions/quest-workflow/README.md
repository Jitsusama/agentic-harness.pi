# quest-workflow

The quest extension: one hierarchy of quests. Replaces the
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
- **The machine's queue**: `queue-first` marks the quest `id`
  names with `queue: first`, so its sessions' builds and checks go
  ahead of other agents' bulk work; `queue-normal` takes it off.
  Either works on any quest, loaded or not, and journals it.
  Priority could not say this: 14 quests sat at driving on 25
  October when one lab's builds were to go ahead.
- **Structural edits**: `reparent` (single or comma-
  separated batch), bulk `conclude` / `retire` (triggered
  by a comma-separated `id` set), and `undo`. All
  structural edits are atomic and journalled so `undo` can
  reverse them. `reparent` and the sweep take a `dryRun`
  preview; `undo` has none, and given one it refuses and
  says what it would reverse. Every session shares the one
  journal, and each entry says whose it is, so `undo`
  reverses only the calling session's own newest change.
  It refuses when the session has none, or when another
  session has changed one of its quests since; an `id`, if
  given, must be one that change touched.
- **Dry runs**: an action that can't preview refuses
  `dryRun: true` and does nothing, rather than dropping it
  and acting for real. That includes `conclude` and
  `retire` of the loaded quest or a document, which only
  the sweep previews. The list of actions that preview is
  in `dry-run.ts`.
- **Aliases**: `alias-add`, `alias-remove`.
- **Orchestration**: `orchestrate` and `unorchestrate` set or
  clear the `orchestrator` mark on the quest `id` names, else
  the loaded one. The session with a marked quest loaded
  orchestrates every quest below it, up to the next marked one;
  those sessions join `#orchestration/<address>` and name it in
  presence as `orchestratedBy`, with nothing else wired. Each
  of those sessions starts with the marked quest's Context
  section in its prompt, as its standing rules, and is told
  once when that section changes. Every
  open marked quest is listed, parents first, in
  `orchestrators.json` in quest-workflow's state folder (its
  id, address, short name, title and parent), looked at again
  after each quest action and at session start, so the
  desktop can offer one that has no session.
- **Quest index**: every open quest is listed the same way in
  `quests.json` beside it, for the launcher's Agents place:
  its id, address, short name, title, Summary, kind, status,
  priority, rank, parent, the address of its orchestrator, its
  documents with their stages, its attached sessions, `start`
  (the folder `spawn` would open it in) and `updated`. What a
  session is doing stays in presence.
- **Sessions**: `session-attach`, `session-detach`,
  `session-rename`, `session-audit` (report any session active on
  more than one quest).
- **Working trees**: `tree-add`, `tree-adopt`, `tree-list`,
  `tree-release`, `tree-expand`. `tree-add` scaffolds a fresh
  worktree the quest owns and auto-prunes on conclude; `tree-adopt`
  registers an existing tree the quest only references and never
  auto-prunes. Both accept a `cwd` parameter, so you scaffold or
  adopt from any session without changing its directory: point
  `cwd` at the repo to scaffold from, or at a path inside the tree
  to adopt. `tree-release` and `tree-expand` take `cwd` the same way,
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
- **Spawn on a machine**: `spawn` with `machine` asks this
  machine's mycelium node to start the session held on that
  machine, through that machine's own node when it is another,
  then opens the usual terminal here on the words the node
  answers that join it. Closing that window leaves the session
  running, and the words join it again from any terminal; the
  answer names the machine and the held id. On another machine
  it begins in the same folder under that machine's home, or in
  its home when there is none there or the folder is outside
  home, and it starts fresh, since a session's history is saved
  on its own machine. A dry run asks the node nothing. A held
  session's terminal is its holder, not kitty, so a session it
  spawns in turn opens a new window rather than a tab. `restore`
  refuses `machine` and `needs`: it reopens this machine's saved
  sessions.
- **Spawn where it fits**: `spawn` with `needs`, each in
  mycelium's own `kind=value` words (`reach=home`,
  `system=macos`), asks the node where such work goes before
  anything else, since resuming holds only on this machine. The
  node chooses among the machines its realm links, ranking down
  one on battery or short of memory or disk, and the session
  starts held there as above, the chosen machine named in the
  start so a machine that changed in between refuses rather than
  taking it. `machine` beside `needs` is one more need. A
  refusal gives the node's reasons for each machine; a dry run
  asks only where it would go.
- **Queries**: `find`, `who`, `links`, `locate` (the inverse
  index: resolve a document id, alias ref or session id to the
  quest that owns it), `ancestors` (trace a quest's parent chain
  up to the root), `sessions` (the sessions at work right now,
  one row each, live first; `workspace`, its old name, is still
  taken).

Destructive verbs take typed parameters, not free-form
prose:

- `tree-release` takes `force: true` to override safety
  refusals.

An action renamed to the glossary's word is still taken under
its old name, so a skill or habit that says `tree-prune` gets
`tree-release`; the schema offers only the new name.

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
  quest's scratch folder; a write inside an untracked git tree
  adopts that tree and goes ahead, and a homeless write is
  refused with `tree-add`. Across stages, `/dev` nodes
  always flow. The agent's commands run with `TMPDIR` set
  to `/tmp/pi-quest-<ID>`, a link to the loaded quest's scratch
  folder's `tmp/`, and `GOCACHE` and `GOMODCACHE` in the scratch
  folder's `cache/`. Conclude and retire remove the whole scratch
  folder, unless a process still works in it, which leaves it to the
  disk guard; a path named in system temp is refused with that remedy. Bash targets resolve as the shell
  would, so `~` is the home directory and a `cd` counts.
- Sharing the machine by quest: the agent's commands and
  subagents carry `PI_QUEST`, the loaded quest's id, and on
  Linux every session keeps `$XDG_RUNTIME_DIR/jobs/quests.json`,
  each open quest's id to a cgroup weight by its priority
  (driving 400, active 200, queued 100, bench 50, someday 25),
  rewritten at session start and after a quest action when it
  would change. A machine that sorts work into a cgroup per
  quest reads both; elsewhere nothing reads them. Beside it,
  `first.json` lists the open quests marked `queue: first`, which
  the machine's queue reads (see priority-workflow).
- Edits to a document's body: `journal` adds a dated
  Journey entry, to the quest `id` names or else the loaded
  one, at the head of its `JOURNEY.md` (the
  README's Journey section only points there, and every
  Journey writer, core's verbs included, writes the file),
  `tick` and `untick` set a checkbox item by
  its number, its text or a unique start of it, and `section` replaces
  one `##` section. Each reads and writes under the quest
  lock and leaves the front matter byte for byte, since the
  workflow rewrites these files between a hand edit's read
  and its write. A hand edit that changes a field the
  workflow owns (a document's `stage`, `id`, `kind` or
  `quest`, a quest's `id`, `kind` or `status`) is refused
  with the verb that changes it.
- Reads of a document's body: `show` given a document's id
  answers its outline (each `##` section with its size, the
  open checkbox items and the next), and with `title` one
  section, or with `query` one item and the notes nested
  under it, matched as `section` and `tick` match them. With
  neither an id nor either of those, `show` projects the
  quest as before. Plans grow past 400 KB, mostly as notes
  under done items, and sessions hunted them with grep and
  sed instead. A shell command that searches or prints a
  document, or a `read` of a whole one, is refused with the
  `show` call that answers it (`quest-document-read`, in
  redirect: asked again, it goes through).
- The gates are guards under the guard policy:
  `quest-record`, `quest-owned-fields` and
  `quest-plan-stage` block. `quest-document-read`,
  `quest-temp` and `quest-homeless` redirect: the agent hears the refusal
  and its remedy, and the same write made again goes
  through as an override you see. Each path those let
  through, outside every tree, is noted in the quest's
  scratch folder (`outside-writes.jsonl`), and `conclude` names
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
