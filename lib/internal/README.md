# Internal Library

Code for this package's extensions alone. There are no barrels:
extensions import the file they need. Nothing outside the package
may import from here, and any of it may change without notice.

## Folders

- **`away/`**: whether the person is away from the machine, shared
  by every session on it and read by the gates without importing
  `away-workflow`, and reaching the person there through a desktop
  notification (`notify.ts`), which decides how while the mesh
  decides when; `PI_NOTIFY=off` silences it.
- **`cache/`**: the model's prompt cache: the prices a compaction is
  weighed at, and keeping an idle session's hour-long entry warm, with
  its record while no pi runs the session and whether a call is on
  that a warm would cut into.
- **`carry/`**: carrying a quest's work to another of the person's
  machines: a session's trees, as bundles and patches, its file, its
  fence and its quest's remembered facts put in the quest's handover
  with a done file saying so, what `pi-carry` carries of the rest,
  arriving with it on the other machine, and letting the old place
  go once it has; for a carry an orchestrator ordered, the refusal a
  session writes and the steer that tells it on arrival who carried
  it and why.
- **`clipboard/`**: Ctrl+V under Wayland without the session
  forking: the shell it forks once for its clipboard reads, and what
  a paste reads and puts in the editor, in pi's own order.
- **`config/`**: the loader for the package's one configuration
  file, and which project a checkout is, for settings keyed by
  project.
- **`errors/`**: telling one failure from another: a failed model
  call a later try could get past, and pi's stale-context error.
- **`fence/`**: the agent fence: its mounts, the copies it binds
  over files, its doors, the routes a refused command is told, its
  Mac profile, its census and its pre-flight checks; which pis it
  takes, the line each refusal leaves in the system's log, and its
  one exemption, a `nix-offload there` call.
- **`files/`**: reading files once and keeping their parse until
  they change.
- **`github/`**: splice-based attribution for `gh pr` and
  `gh issue` commands, re-exported from core.
- **`guardian/`**: what the public `guardian/` contract leaves out:
  `guards.ts`, the catalogue every guard here is declared from; the
  last-outcome registry `/guards` reads; the commit hook and
  trailer; the entity review the commit, PR and issue guardians
  share; and the session-backed store of violation signatures the
  prose, section and Slack gates have already blocked.
- **`install/`**: whether the installed dependencies and checkout
  are the ones on disk, and which builds the install skipped, for
  `install-check-workflow` and `pnpm load-check`, read once for
  every conversation one load serves.
- **`links/`**: what a click on pi's fullscreen lands on: the
  places plain text names, where each opens, and the one wrap of
  pi-tui's press that lets `link-click-widget` open them.
- **`logs/`**: session logs read back: every log a span holds, pi's
  entries as plain turns, and searching a session's own log so what
  a compaction dropped stays within reach.
- **`machine/`**: this machine: its name as its realm's other
  machines say it, the realm a session lives in, and when it booted.
- **`people/`**: the built-in handle types (Slack, GitHub, email),
  the resolvers and where people are stored.
- **`pineapple/`**: Joel's safe word at the tool call: the stops
  core's pineapple reader writes, which tool calls are writes and
  where they go, which stops reach them, which sessions they park,
  the mesh holds they send, and the guard on their own records, for
  `pineapple-workflow`.
- **`priority/`**: the machine queue: when a session's heavy work
  may run, by memory, VM limits and who is waiting on it.
- **`process/`**: one process's shared state and how its callers
  take turns: singletons across module instances, a FIFO mutex and
  one flight per key.
- **`quest/`**: everything behind the quest tool: discovery, the
  documents' fields and edits, sessions and trees, in folders by what
  changes together, its own note naming each.
- **`refs/`**: the built-in reference types: GitHub issues, pull
  requests and repos, Slack messages and threads.
- **`registry/`**: pluggable registries kept on `globalThis` under a
  `Symbol.for` key, so a reload or a second module instance finds
  the same one.
- **`reload/`**: following the install, reloading a session onto
  a worktree, and telling which extension links moved since the
  process started, which only a new process loads afresh.
- **`sandbox/`**: which sandbox a session asked for and what both
  sandboxes build on: the shell text, which tree a fenced command
  stands in and where pi may run git outside it, the programs that
  run outside it, running git and gh with nobody at the keyboard,
  the check pi's own file tools are held to, and the brokers'
  hour-long cloud and GitHub tokens for the strict sandbox.
- **`secrets/`**: credentials kept from what the model and the disk
  see: the shapes one takes in a tool's output and the mark that
  replaces it, and an agent's ask for one work secret.
- **`session/`**: rolling a session over into a fresh log that
  keeps only what the model still sees, on the model it ran on, and
  reading a log's header to tell a log that carries a session on
  from another conversation's, what a session landed, said on
  the bus for its presence to keep, whether a fleet or a round
  may run on a model the agent named rather than the person, and
  the rules of a repo a session takes a tree in but pi loaded none
  of at its start, and what will wake a session resting blocked,
  asked of the extensions that hold it; and, for a move between
  plain pi and a host, what holds a session from ending, the note
  a moving session leaves for whoever takes its file up, and
  whether a person drives it; the variables saying how a session's
  commands run, which every way back into it hands on; and the
  context's usage, worked out once per leaf however many extensions
  ask; and the one listener every extension hears a turn's end
  through, since pi rebuilds the whole context after each listener;
  and, for a park under niri, which of a parked pi's windows may
  close (`park-window.ts`) and the calls to niri, kitty and the
  launcher that close them (`park-desktop.ts`); and an extension's
  state, kept as entries in the session's log and restored from the
  last one (`state.ts`).
- **`shell/`**: what the agent's shell runs with, offered by the
  extensions that know, and its commands started by pi-spawner, so
  pi never forks itself to start one, a host's in a systemd scope of
  its own where it can (`spawner-scope.ts`); what a bash call keeps of
  itself on disk, so a move can carry it to a host, which watches it
  there and says its end in the words its own pi would have, and the
  record of each one a session hands to a job, so the session takes it
  up again after a kill that carried nothing (`kept-jobs.ts`); and the
  reaper that kills what a call left, by its mark; and the shell
  habits the standing rules forbid (output cut with tail, long
  sleeps, git stash), as `shell-habit-interceptor` catches them
  (`shell-habits.ts`).
- **`spend/`**: what the session spends and what is left: the bill and
  budgets asked of spend-watch, a Claude plan's allowances, the
  resources a process used, and the status line's money and context.
- **`stray/`**: catching writes that would land behind pi's screen.
- **`verbs/`**: the verbs server the launcher keeps a connection to:
  each verb as its markdown file says it, the prompt it builds over a
  selection once the scrubber finds no secret in it, each use and what
  became of it, a thin client for agents and tests, and what
  pi-verbs' words ask, read before it looks for its socket.
- **`verification/`**: a process-global check another extension can
  ask whether the code is failing.

## Files

- **`automated.ts`**: the turns the harness starts itself, through
  pi's prompt path.
- **`nearest.ts`**: the known word nearest one typed wrongly, by
  edit distance, which a command or tool says back when it doesn't
  know a word: the quest tool's actions, pi-verbs' commands.
- **`paths.ts`**: the package's configuration, data, state and cache
  paths, by the XDG base directories.
- **`process-ticks.ts`**: a process's start in the kernel's ticks
  since boot, which no suspend or clock change moves, and the one
  judgement of whether a recorded process (a mesh presence, a
  fleet's owner) still runs.
- **`record.ts`**: whether a parsed value is an object whose keys
  can be read by name; one copy for the whole package, `lib/core`
  included.
- **`void-owner.ts`**: who owns a line Joel says into the void, read
  from what he attached (a pi session, a pull request, a page, a
  window) and from the quests that claim it, for
  `scripts/void-owner.ts`.
- **`work-records.ts`**: where the work broker writes down the trees
  it cut, and which trees each session holds, for the work extension
  and for carrying a session's work.
- **`write-whole.ts`**: replacing a file whole through a `.writing`
  subfolder, so a watcher of its folder hears one event a write.
