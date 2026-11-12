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
  separated batch), the `conclude` / `retire` sweep (an
  `id` naming quests not loaded here), and `undo`. All
  structural edits are atomic and journalled so `undo` can
  reverse them, but for the sweep's removal of each quest's
  scratch folder: its `undo` restores status and priority
  only, and both its answer and its dry run name each
  folder that goes. `reparent` and the sweep take a `dryRun`
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
  once when that section changes. A quest whose README says
  `context-stands: true` adds its own Context after them.
  Until Monday 16 November 2026, half of WCJQSG's builders
  (an odd second-to-last hex digit in the session id, all
  but WCJQSG and 16V6F4) also hear one habit line, sending
  independent looks in one step, as a trial
  (`batching-trial.ts`). A quest id on its own line in
  `mission/trials/batching-out` under the state folder takes
  that quest's sessions out at their next turn, and
  `PI_BATCHING_TRIAL=off` ends it everywhere. Every
  open marked quest is listed, parents first, in
  `orchestrators.json` in quest-workflow's state folder (its
  id, address, short name, title and parent), looked at again
  after each quest action and at session start, so the
  desktop can offer one that has no session.
- **Quest index**: every open quest is listed the same way in
  `quests.json` beside it, for the launcher's Agents place:
  its id, address, short name, title, Summary, kind, status,
  priority, rank, parent, the address of its orchestrator, its
  documents with their stages, its attached sessions, `resume`
  (the session a closed quest reopens in, its folder, and `at`,
  when it was last live by its log or its presence), `start`
  (the folder `spawn` would open it in) and `updated`. What a
  session is doing stays in presence. A session started with
  `QUEST_WORKFLOW_ORCHESTRATE=1` beside
  `QUEST_WORKFLOW_AUTOLOAD_ID` marks the quest it loads as
  orchestrating, which is how the launcher starts an
  orchestrator for a quest that never had one.
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
  none of them is refused with the list. `tree-expand` pointed at
  a git tree the quest has no record of adopts it first, as
  `tree-adopt` would, refusing one another quest holds or a
  repository's main checkout, since adding a zone changes nothing
  already checked out.
- **Terminal spawn**: `spawn`, `spawn-tab`, `spawn-pane`,
  `spawn-window`, and `reopen-sessions` with `force`. Each takes
  `terminal`, `layout` and `nesting` for the call and
  `dryRun` to see the decision without opening anything;
  otherwise the person's `terminal` settings decide, by
  quest, by project or by default, and the answer names the
  layer that chose. The command is typed into a login shell
  so the person's startup files put the right pi on PATH.
  A spawn that reopens a session (`pi --session`, given or
  picked) opens where that session ran, since pi finds a
  session by id only among the logs of the folder it starts
  in. Any other opens in the quest's newest tree, else its latest
  live session's folder, else a tree's repo, else the
  checkout a parent quest's newest tree was cut from, else
  the spawning session's folder when it is in a repo (its
  checkout, when that is a linked worktree), and only then
  home. It never opens in the quest store or inside a parent
  quest's tree, which is that quest's alone, and says which
  chose: pi loads a repo's
  AGENTS.md only when it starts inside it, and a new builder
  subquest has nothing of its own yet.
  `reopen-sessions` gathers tabs with no window to hold them into one
  new window, and counts a session reopened only once its pi
  has started. A lost session pi never saved, since it was
  lost before its first message, has nothing to resume:
  it starts a fresh pi on its quest in its folder
  instead, says so, and stops offering it once a session is
  running in its place. See the terminal library's README for
  the settings.
- **Replaces a window, never adds one**: before `reopen-sessions`
  with `force`, or a `spawn` that resumes a session, opens anything,
  it asks the machine's node what it holds (`mycelium held`). A
  session a holder still runs is left alone; one held parked is
  woken in its own window; and for the rest, every window still
  showing it with no pi left under it is closed: the holder's, and
  any kitty window marked `pi_session=<id>`. A window it opens
  itself ends with its pi (`exec`), carries that mark, and sits
  on its orchestrator's workspace, the orchestrator's window first
  and its sessions after it by title (`window-place.ts`). Off
  Linux, and with `PI_SETTLE=off`, as the tests set, it settles
  nothing.
- **Reopen through the launcher**: `reopen-sessions` with `force`
  first hands the sessions pi saved to the desktop's launcher
  (`qs ipc call sessions reopen`), which opens them one at a
  time, each back on its workspace in its place, so one placer
  orders the screen. It doesn't when the call names a terminal,
  layout or nesting, in a realm other than the machine's home
  one, or with `PI_LAUNCHER=off`, as the tests set. What the
  launcher doesn't take, every one when it doesn't answer, and
  a session pi never saved open as above, two seconds apart.
- **Spawn through the launcher**: a `spawn` the settings would
  open as a kitty window of plain pi, on this machine, goes to
  the launcher the same way, so it places that window too: a
  resumed session by its id, a new one marked fresh with an id
  minted for it and its quest, which the launcher starts with
  `pi --session-id`. A restart's `command`, `pi --session <id>`
  alone or with `--model <model>`, goes too, with that model, and
  so does a new `pi --model <model>`.
- **On the spawner's model**: a spawn that starts pi by itself,
  new or resumed, starts it with `--model` set to the asking
  session's model and thinking level, so it never falls to
  whatever pi's default says. A `command` the call gives, or an
  agent a realm starts in pi's place, keeps its own.
  The same cases as reopen-sessions' leave it out, and so do
  another terminal or layout, any other command and another
  machine; a launcher that doesn't take it leaves the window to
  open as above. A dry run asks it nothing.
- **Without taking focus**: every session reopen-sessions and
  spawn hand the launcher goes with `focus: false`, its quest and
  the session that asked, so its window opens unfocused where its
  quest's sessions are. A session reopened or resumed also says
  `replaces`, its own id, so it opens where its window was; one
  they open themselves leaves focus where it is (lib/terminal). Only the person's own press focuses a window.
- **Sets to work by itself**: a session a spawn starts running
  pi, fresh, resumed or with flags the call's `command` gives it
  (`pi --model ...`), or behind a holder's `--`
  (`mycelium --realm work hold -- pi ...`), is told first to carry on with its quest
  from its README and focused plan, and, when the spawn gives
  `note`, what it was started for. The spawn leaves the words in
  the quest workflow's state folder, named by the session's id for
  the launcher and by a token in the new pi's environment
  otherwise; the session takes them as it starts and sends them
  as an automated turn, unless its command line already gave pi a
  first prompt. Words wait 15 minutes at most. A session held on
  another machine can't reach them and starts without.
- **Or its spawner hears**: a minute after a spawn that left
  words, the spawning session looks for the new session's first
  turn: the record it left of taking its words, and a user
  message in its log. While the words still wait and a process
  names the session, its pi is taken to be starting, and it looks
  again each minute for up to 5 minutes. When there is none it
  starts its own turn,
  naming the session, the quest and what the records show; when
  the session ran, it says nothing.
- **Says when trust waits**: a pi started in a folder pi will ask
  to trust (resources its trust gates, no saved decision, the
  default `ask`, and no `--approve` or `--no-approve`) stops at
  that prompt before it reads its words. The spawn's answer says
  so, and the look a minute on tells at once, naming the folder,
  rather than waiting 5 minutes for a slow start. A tree the
  work tool cut is trusted by the harness itself
  (work-integration), so a spawn there never waits on it.
- **Behind a lock**: a session handed to the launcher while the
  screen is locked starts behind the lock and goes to its place
  once the lock is gone.
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
  session runs under its holder, not kitty, so a session it
  spawns in turn opens beside the window the node says it is
  shown in (see the terminal library's README). `reopen-sessions`
  refuses `machine` and `needs`: it reopens this machine's saved
  sessions.
- **Spawn into a host**: `spawn` with `host` set to `attended` or
  `background` asks this realm's shared pi host, over its control
  socket, to hold the session rather than opening a terminal. The
  realm and socket come from the asking conversation's environment,
  never the host process's. A fresh session is opened with its quest,
  the spawner's model and its first words in the one request; a
  resumable one is adopted from its log and told nothing, so a note
  beside it is refused, as is adopting a session still live. It goes
  alone: `terminal`, `layout`, a `spawn-*` verb, `nesting`,
  `machine`, `needs` and `command` are refused beside it, and so is a
  quest whose needs place it on another machine. A host that refuses
  names its code; one that never answers, or answers something
  unreadable, leaves the outcome unknown, and nothing is retried or
  opened in its place. A dry run calls nothing. `reopen-sessions`
  refuses `host`. An attended host's answer gives the words that
  view the session: `mycelium --realm <realm> attach --host <key>
  --session <id>`.
- **Spawn into a host by default**: `spawnHost` in the config's
  `quest-workflow` section (`off`, the default, `attended` or
  `background`) sends a plain `spawn` to that host as if it named
  `host`, read at each spawn, so it takes with no reload. A spawn
  naming a host, `terminal`, `layout`, `nesting`, `machine`, `needs`
  or `command`, or a `spawn-*` verb, goes as it says. It opens in a
  terminal, and says why, when the quest's needs place it on another
  machine, the realm starts an agent other than pi (a personal realm's
  pi-claude), or no host of the kind is there: no realm, no socket, or
  nothing listening, which a `list` asks, in a dry run too. A host
  that is there and refuses opens nothing else, as with `host`. A
  setting it can't read is said and left off. The pi the desktop's
  launcher starts for a spawn reads the setting again before it draws
  (`launched-spawn.ts`), so a spawner that hasn't reloaded since the
  setting came still lands in the host: the pi opens the conversation
  there with the spawn's first words and ends, and its window closes
  with no frame drawn, after a blink while the window's shell starts.
  The host names that session itself, so the spawn's own id is
  recorded as taken by it, which is how the spawner's look for its
  first turn finds it started. When the host isn't there or turns it
  away, the pi stays in its window, says why, and starts as usual;
  each one leaves a line in `launched-spawns.log` in the extension's
  state folder.
- **Decide before any window opens**: to take out that blink, the
  launcher first runs `scripts/spawn-decide.ts --session-id ID
  [--model M]` headless, in the spawn's folder and environment. It
  loads no pi, and prints only on stdout. It prints `opening <host>`
  once the open is sent, from when the launcher waits for its answer
  rather than open a window that would start a second session. It
  exits 0 with `hosted <host> <session>`, and nothing opens; or 3 with
  why it stays, empty when `spawnHost` is off or it isn't a spawn, and
  the launcher opens the window with `QUEST_WORKFLOW_SPAWN_STAYED` set
  to that, which its pi says once up rather than decide again. Any
  other exit opens the window as before, whose pi decides itself, and
  so does no `opening` within 3 s, once the launcher has ended the
  decider. After `opening` the answer can take up to 120 s, since the
  host loads pi and the harness for the conversation before it answers;
  a spawn's open waits that long anywhere, rather than leave its
  outcome unknown. Its log lines end `(headless, N ms)`.
- **Start into a host**: `startHost` in the same section (`off`, the
  default, or `attended`) sends the launcher's own Start a Session and
  Orchestrate to the attended host, apart from `spawnHost`, since a
  person's own sessions move only by their choice. The launcher asks
  `scripts/spawn-decide.ts --start [--orchestrate] [--model M]` in the
  quest's folder with the quest to load, with the same lines and exits
  as a spawn's. A start goes to the host only with the setting on and
  the host listening; the conversation opens idle on its quest,
  orchestrating for Orchestrate, told nothing, since the person types
  first. On `hosted <host> <session>` the launcher opens its viewer at
  once (`mycelium --realm <realm> attach --host <host> --session
  <session>`). Otherwise it opens the window as ever.
- **Resume in a host**: `/quest-resume <id>` switches pi to a
  session attached to the loaded quest. A hosted conversation can't
  switch its log, which its host owns, so there it asks the realm's
  attended host what it holds: a session already held is only
  pointed at, and any other is adopted from its log with spawn's
  refusals. The answer is a notice and a `quest-resume` message in
  the conversation, whose details say `sessionId`, `host`, `adopted`
  and the `attach` words, since a host with no viewer keeps no
  notice. A session a host ran comes back through that host,
  so `reopen-sessions`, the start-up count of lost sessions and the
  restore at boot all leave it out, and its `restore.json` entry is
  marked `hosted` for the launcher to skip: a terminal over its log
  as well would be two pi on one log.
- **Windows on another machine's sessions**: a session another
  machine holds keeps running through this machine's power-off, so
  what the boot takes away is only the window joined to it.
  `scripts/windows-elsewhere.ts`, run each minute by a user timer,
  notes each window here whose foreground command is such a
  session's attach words, as the mycelium node gives them, in
  `windows-elsewhere.json` beside the session records. The next
  boot's `restore.json` offers each as an entry with `machine` and
  `attach`, for the launcher to rejoin, and `reopen-sessions` lists the
  words. A session joined again in a window now drops out.
  A session pi never saved is offered too, marked `fresh`, which
  the launcher starts afresh under its id with `pi --session-id`,
  its quest autoloaded, since there is no file to resume.
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
- **What a quest needs of a machine**: `need-add` and
  `need-remove` keep a quest's `needs` in its front matter, in
  the same `kind=value` words, each checked as the node reads
  it, on the quest `id` names or the loaded one. `spawn` given
  neither `machine` nor `needs` places by the spawned quest's
  own needs; either one named replaces them. A quest with none
  starts here, as before, and a subquest takes none from its
  parent.
- **What a quest's model calls draw on**: `budget` with `ref`
  names a quest's budget (`none` for the session's default,
  `inherit` to take its own away), and without `ref` says what
  it draws on and which quest named it. A subquest draws on its
  nearest ancestor's. The workflow hosts the budget providers
  (`lib/budget/`): when the session starts, after each quest
  action and at each turn's end, it asks them what the loaded
  quest's budget means and lays the variables they answer over
  the session's own environment, keeping what they replaced and
  putting it back when the quest draws on none or is put down.
  Model providers read their keys as each request is made, so
  the next one draws on it, and the commands and subagents the
  session starts afterwards inherit it. A session spawned for
  another quest does not: its terminal starts with the
  environment as it was before any budget, and it draws on its
  own quest's. The footer says the budget drawn on, through
  spend-workflow, which hears it on the bus (`budget:settled:v1`)
  each time it settles; a name
  no provider knows, or one it can't draw on yet, leaves the
  default and says why once. Nothing of it reaches the prompt.
  The session's log says it too: a `budget` entry
  (`{"v": 1, "name": "delta", "label": ..., "provider": ...}`,
  `name` null for the default) at start and each time what it
  draws on changes, read from `PI_BUDGET`, which is laid with the
  budget's variables. So whatever prices the log (spend-watch,
  the ledger) gives each request the budget of the nearest entry
  before it on its branch, and a session started under a budget
  with no quest of its own records the one it inherited.
  A provider has 5 s to answer before it counts as unavailable,
  and the session waits on it only before a model call, never at
  start. Switching budgets mid-session costs one full cache
  write on the next turn, since the new key's cache is cold.
  A reload or a session switch ends the old load's keeping: an
  answer still on its way when it lands is dropped, laying and
  writing nothing, rather than read with a context that now
  throws, and the next load asks again.
- **The realm's own agent**: a spawn that runs pi, fresh or
  resuming, runs instead the command the chosen machine's node
  declares for the session's realm (`declared.agents`), here or
  held. On optimus the personal realm declares `pi-claude`, so a
  session spawned there stays on Joel's Claude plan and off the
  work mesh. A command the call names, a machine that declares
  none, and a node that doesn't answer keep plain pi.
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
  adopts that tree and goes ahead, and a homeless write goes
  ahead and is noted for the quest. Across stages, `/dev` nodes
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
  the machine's queue reads (see priority-workflow), and
  `parents.json` maps each open subquest to its parent's id, so
  a sorter placing work by tier walks a quest up to the nearest
  ancestor its tier map names.
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
  section, or, where no `##` section bears the name, a
  deeper heading up to the next at its level, or with
  `query` one item and the notes nested
  under it, matched as `section` and `tick` match them. Words
  in `query` that no item reads list the lines holding them
  instead (`a|b` for either), each with its section and its
  number in the file for a `read` with an offset; a bare
  number is only ever an item. With
  neither an id nor either of those, `show` projects the
  quest as before. Plans grow past 400 KB, mostly as notes
  under done items, and sessions hunted them with grep and
  sed instead. A shell command that searches or prints a
  document, or a `read` of a whole one, is refused with the
  `show` call that answers it (`quest-document-read`, in
  redirect: asked again, it goes through). A codemode
  script's read goes through at once, since only what the
  script returns reaches the context.
- The gates are guards under the guard policy:
  `quest-record`, `quest-owned-fields` and
  `quest-plan-stage` block. `quest-document-read` and
  `quest-temp` redirect: the agent hears the refusal
  and its remedy, and the same write made again goes
  through as an override you see. `quest-homeless` redirects
  by letting the write through and noting it, said once per
  session, since nearly every write it refused was made
  again; `/guards quest-homeless block` restores the refusal.
  Each path those let
  through, outside every tree, is noted in the quest's
  scratch folder (`outside-writes.jsonl`), and `conclude` names
  them in its message and Journey, so a quest accounts for
  everything it touched. A path already noted there flows
  from then on, since the quest has accounted for it.
  `quest-untracked-tree`
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
- A session on screen ends itself once its quest has ended
  (`ends-with-quest.ts`), as Joel asked on 4 November: "make
  sure we are closing any pi processes and/or kitty windows
  that are no longer needed". Once a minute it reads its loaded
  quest's status afresh, since another session may have
  concluded it; when the quest is concluded or retired and, at
  two looks in a row, no turn runs, no message waits and nothing
  is typed in the prompt, it shuts pi down and its window closes
  with it. In a host, the host closes it, and its journal names
  the quest that ended it. A session with no quest loaded, or one that loaded
  another, is left running.
- Telling the model which quest and document it is on. The
  line is frozen into the system prompt the first time a
  session renders it, and a later load, focus or stage change
  is said once as an appended message, so a quest action
  never rewrites the cached conversation. What was frozen and
  last said is persisted, so a reload renders the same bytes;
  a compaction resets it so a changed state is said again.
- What's on top: a few quests the person put first, why in
  their words, and until when, read from
  `$XDG_STATE_HOME/mission/top.json` (`on-top.ts`). Nothing
  here writes it yet: the orchestrator writes it by hand until a
  `quest top` action lands, as `{"quests": [{"id", "title"}],
  "why", "until": "YYYY-MM-DD" or null, "at", "by"}`, and every
  session hears it as a standing context at its next turn, so
  telling them costs no turn of its own. It lapses after its
  `until` day, and a file that doesn't parse leaves the last
  one standing, while a whole file naming no quest takes it
  down. Each session that reads a top leaves its id under
  `mission/top-reads/<at>/`, so the count is the receipt; a new
  top takes the older tops' reads away.

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
`~/.config/pi/agentic-harness.pi/config.json`. The same section
takes `spawnHost` (see Spawn into a host by default) and
`startHost` (see Start into a host):

```json
{ "sections": { "quest-workflow": { "spawnHost": "background", "startHost": "attended" } } }
```
