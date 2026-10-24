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
  are the ones on disk, for `install-check-workflow`.
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
  keeps only what the model still sees.
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
- **`notify.ts`**: reaching the person at the machine through a
  desktop notification. It decides how; the mesh decides when.
  `PI_NOTIFY=off` silences it.
- **`package-state-dir.ts`**: one extension's state directory,
  under `pi/agentic-harness.pi/<extension>/`.
- **`paths.ts`**: the package's configuration, data, state and cache
  paths, by the XDG base directories.
- **`process-global.ts`**: singletons shared across an extension's
  module instances.
- **`project.ts`**: which project a checkout is, for settings keyed
  by project.
- **`resources.ts`**: the CPU, disk and memory this pi process and
  its work used, from the kernel's counters.
- **`single-flight.ts`**: one flight per key, which later callers
  join.
- **`stale.ts`**: telling pi's stale-context error, after a reload
  or session switch, from any other.
- **`state.ts`**: persisting an extension's state across sessions
  and restoring it.
- **`transcript.ts`**: pi's session entries as the plain turns the
  governance distiller reads.
- **`unattended-exec.ts`**: running git and gh with nobody at the
  keyboard.
