# Internal Library

Code for this package's extensions alone. There are no barrels:
extensions import the file they need. Nothing outside the package
may import from here, and any of it may change without notice.

## Folders

- **`away/`**: whether the person is away from the machine, shared
  by every session on it and read by the gates without importing
  `away-workflow`.
- **`carry/`**: carrying a quest's work to another of the person's
  machines: a session's trees, as bundles and patches, and its file
  put in the quest's handover with a done file saying so, what
  `pi-carry` carries of the rest, and arriving with it on the other
  machine.
- **`clipboard/`**: Ctrl+V under Wayland without the session
  forking: the shell it forks once for its clipboard reads, and what
  a paste reads and puts in the editor, in pi's own order.
- **`config/`**: the loader for the package's one configuration
  file.
- **`cost-meter/`**: what the status line says about money and
  context, shared by the extension that knows the figures and the
  widget that lays them out.
- **`gate/`**: the session-backed store of violation signatures the
  prose, section and Slack gates have already blocked.
- **`github/`**: splice-based attribution for `gh pr` and
  `gh issue` commands, re-exported from core.
- **`guardian/`**: what the public `guardian/` contract leaves out:
  `guards.ts`, the catalogue every guard here is declared from; the
  last-outcome registry `/guards` reads; the commit hook and
  trailer; and the entity review the commit, PR and issue guardians
  share.
- **`install/`**: whether the installed dependencies and checkout
  are the ones on disk, and which builds the install skipped, for
  `install-check-workflow` and `pnpm load-check`.
- **`links/`**: what a click on pi's fullscreen lands on: the
  places plain text names, where each opens, and the one wrap of
  pi-tui's press that lets `link-click-widget` open them.
- **`people/`**: the built-in handle types (Slack, GitHub, email),
  the resolvers and where people are stored.
- **`priority/`**: the machine queue: when a session's heavy work
  may run, by memory, VM limits and who is waiting on it.
- **`quest/`**: everything behind the quest tool: discovery, the
  documents' fields and edits, sessions and trees.
- **`recall/`**: searching a session's own log, so what a compaction
  dropped stays within reach.
- **`refs/`**: the built-in reference types: GitHub issues, pull
  requests and repos, Slack messages and threads.
- **`registry/`**: pluggable registries kept on `globalThis` under a
  `Symbol.for` key, so a reload or a second module instance finds
  the same one.
- **`reload/`**: following the install, and reloading a session onto
  a worktree.
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
  whether a person drives it.
- **`shell/`**: what the agent's shell runs with, offered by the
  extensions that know.
- **`stray/`**: catching writes that would land behind pi's screen.
- **`verification/`**: a process-global check another extension can
  ask whether the code is failing.

## Files

- **`async-mutex.ts`**: a FIFO mutex for critical sections within
  one process.
- **`automated.ts`**: the turns the harness starts itself, through
  pi's prompt path.
- **`booted.ts`**: when the machine booted, which bounds what is
  still under way.
- **`cache-prices.ts`**: the cache prices a compaction is weighed
  at, from the active model's own rates.
- **`cache-warming.ts`**: the rules for keeping an idle session's
  hour-long cache entry warm: when a warm falls due, which requests
  may be replayed, and when a warm missed its prefix.
- **`claude-plan.ts`**: where a Claude plan's five-hour and weekly
  allowances stand, read from what the Claude Code provider says
  after each turn, for spend-workflow's budget item.
- **`gcloud-broker.ts`**: the hour-long cloud tokens the machine's
  gcloud-broker mints for its agents' account, asked for in the
  background every few minutes for the strict sandbox.
- **`github-broker.ts`**: the hour-long GitHub tokens the machine's
  github-broker gives the strict sandbox, asked for every few minutes.
- **`machine.ts`**: this machine's name as its realm's other
  machines say it, its hostname's short form, and what may be one.
- **`model-failure.ts`**: whether a failed model call is one a
  later try could get past, by pi's own judgement, and the wait
  before each try, for `model-retry-workflow` and the compaction
  summary.
- **`notify.ts`**: reaching the person at the machine through a
  desktop notification. It decides how; the mesh decides when.
  `PI_NOTIFY=off` silences it.
- **`paths.ts`**: the package's configuration, data, state and cache
  paths, by the XDG base directories.
- **`process-global.ts`**: singletons shared across an extension's
  module instances.
- **`process-ticks.ts`**: a process's start in the kernel's ticks
  since boot, which no suspend or clock change moves, and the one
  judgement of whether a recorded process (a mesh presence, a
  fleet's owner) still runs.
- **`project.ts`**: which project a checkout is, for settings keyed
  by project.
- **`record.ts`**: whether a parsed value is an object whose keys
  can be read by name; one copy for the whole package, `lib/core`
  included.
- **`resources.ts`**: the CPU, disk and memory this pi process and
  its work used, from the kernel's counters.
- **`sandbox.ts`**: the strict sandbox's fence, as landrun's rules
  around each command the shell workflow runs, and as the check
  `sandbox-file-interceptor` holds pi's own file tools to.
- **`secrets.ts`**: the shapes a credential takes in a tool's output,
  and how one is replaced by a mark naming its kind, for the answers,
  the saved output and the stored results that hold them.
- **`session-logs.ts`**: every session log a span holds, those still
  on the machine and those only on Drive, read back through
  session-backup's index one at a time and removed once read, for
  the sensors that mine the logs.
- **`shell-habits.ts`**: the shell habits the standing rules
  forbid (output cut with tail, long sleeps, git stash), as
  `shell-habit-interceptor` catches them.
- **`single-flight.ts`**: one flight per key, which later callers
  join.
- **`spend-watch.ts`**: the bill for a period, asked of spend-watch's
  command line where it is installed, for the spend tool.
- **`spend-watch-budgets.ts`**: where every budget stands, its
  allowances in their own units, and the total across all AI spend,
  asked of `spend-watch budgets --json`, for the footer and `/budget`.
- **`stale.ts`**: telling pi's stale-context error, after a reload
  or session switch, from any other.
- **`state.ts`**: persisting an extension's state across sessions
  and restoring it.
- **`transcript.ts`**: pi's session entries as the plain turns the
  governance distiller reads.
- **`unattended-exec.ts`**: running git and gh with nobody at the
  keyboard.
- **`work-records.ts`**: where the work broker writes down the trees
  it cut, and which trees each session holds, for the work extension
  and for carrying a session's work.
- **`write-whole.ts`**: replacing a file whole through a `.writing`
  subfolder, so a watcher of its folder hears one event a write.
