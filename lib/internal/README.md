# Internal Library

Code for this package's extensions alone. There are no barrels:
extensions import the file they need. Nothing outside the package
may import from here, and any of it may change without notice.

## Folders

- **`away/`**: whether the person is away from the machine, shared
  by every session on it and read by the gates without importing
  `away-workflow`.
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
  from another conversation's.
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
- **`cache-prices.ts`**: the cache prices a compaction is weighed
  at, from the active model's own rates.
- **`claude-plan.ts`**: where a Claude plan's five-hour and weekly
  windows stand, read from what the Claude Code provider says after
  each turn, and the footer's words for them.
- **`model-failure.ts`**: whether a failed model call is one a
  later try could get past, by pi's own judgement, and the wait
  before each try, for `model-retry-workflow` and the compaction
  summary.
- **`notify.ts`**: reaching the person at the machine through a
  desktop notification. It decides how; the mesh decides when.
  `PI_NOTIFY=off` silences it.
- **`package-state-dir.ts`**: one extension's state directory,
  under `pi/agentic-harness.pi/<extension>/`.
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
  can be read by name; one copy for the package outside `lib/core`.
- **`resources.ts`**: the CPU, disk and memory this pi process and
  its work used, from the kernel's counters.
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
- **`stale.ts`**: telling pi's stale-context error, after a reload
  or session switch, from any other.
- **`state.ts`**: persisting an extension's state across sessions
  and restoring it.
- **`transcript.ts`**: pi's session entries as the plain turns the
  governance distiller reads.
- **`unattended-exec.ts`**: running git and gh with nobody at the
  keyboard.
- **`write-whole.ts`**: replacing a file whole through a `.writing`
  subfolder, so a watcher of its folder hears one event a write.
