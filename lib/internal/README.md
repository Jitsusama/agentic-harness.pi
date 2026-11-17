# Internal Library

Code for this package's extensions alone. There are no barrels:
extensions import the file they need. Nothing outside the package
may import from here, and any of it may change without notice.

## Folders

- **`away/`**: whether the person is away from the machine, shared
  by every session on it and read by the gates without importing
  `away-workflow`, and reaching the person there through a desktop
  notification (`notify.ts`).
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
  file.
- **`cost-meter/`**: what the status line says about money and
  context, shared by the extension that knows the figures and the
  widget that lays them out.
- **`errors/`**: telling one failure from another: a failed model
  call a later try could get past, and pi's stale-context error.
- **`fence/`**: the agent fence: its mounts, the copies it binds
  over files, its doors, the routes a refused command is told, its
  Mac profile, its census and its pre-flight checks.
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
- **`people/`**: the built-in handle types (Slack, GitHub, email),
  the resolvers and where people are stored.
- **`pineapple/`**: Joel's safe word at the tool call: the stops
  core's pineapple reader writes, which tool calls are writes and
  where they go, which stops reach them, which sessions they park,
  the mesh holds they send, and the guard on their own records, for
  `pineapple-workflow`.
- **`priority/`**: the machine queue: when a session's heavy work
  may run, by memory, VM limits and who is waiting on it.
- **`quest/`**: everything behind the quest tool: discovery, the
  documents' fields and edits, sessions and trees.
- **`refs/`**: the built-in reference types: GitHub issues, pull
  requests and repos, Slack messages and threads.
- **`registry/`**: pluggable registries kept on `globalThis` under a
  `Symbol.for` key, so a reload or a second module instance finds
  the same one.
- **`reload/`**: following the install, reloading a session onto
  a worktree, and telling which extension links moved since the
  process started, which only a new process loads afresh.
- **`sandbox/`**: what both sandboxes build on beside `sandbox.ts`:
  the shell text, which tree a fenced command stands in, the check
  pi's own file tools are held to, and the brokers' hour-long cloud
  and GitHub tokens for the strict sandbox.
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
  launcher that close them (`park-desktop.ts`).
- **`shell/`**: what the agent's shell runs with, offered by the
  extensions that know, and its commands started by pi-spawner, so
  pi never forks itself to start one; what a bash call keeps of
  itself on disk, so a move can carry it to a host, which watches it
  there and says its end in the words its own pi would have; and the
  reaper that kills what a call left, by its mark; and the shell
  habits the standing rules forbid (`shell-habits.ts`).
- **`stray/`**: catching writes that would land behind pi's screen.
- **`verbs/`**: the verbs server the launcher keeps a connection to:
  each verb as its markdown file says it, the prompt it builds over a
  selection once the scrubber finds no secret in it, each use and what
  became of it, a thin client for agents and tests, and what
  pi-verbs' words ask, read before it looks for its socket.
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
- **`calls.ts`**: whether a call is on, as `a-call-is-on` says, for
  work that would cut into one, such as a warm's upload.
- **`claude-plan.ts`**: where a Claude plan's five-hour and weekly
  allowances stand, read from what the Claude Code provider says
  after each turn, for spend-workflow's budget item.
- **`fence-log.ts`**: the line each sandbox refusal in pi's own
  process leaves in the system's log under `pi-fence`, naming the
  tool, sandbox and session but never what was asked for.
- **`fence-stage.ts`**: which pis the fence takes by default in its
  first stage (subagents, fresh `quest spawn` sessions and those listed
  by hand, under pi's state, `scripts/fence-stage.ts`), and how
  `PI_SANDBOX` reads: `off` runs a session as it is, and an empty or
  unknown value reads as the fence, saying so once.
- **`file-reads.ts`**: what each file in a folder said when the
  process last read it, asked again only once the file changes, so a
  ledger asked at every conversation's start reads only what moved.
- **`folder-mirror.ts`**: a folder's files and their parses, kept for a
  host's synchronous readers and read again off the thread each second
  while asked, so a stalled disk holds none of its conversations.
- **`machine.ts`**: this machine's name as its realm's other
  machines say it, its hostname's short form, and what may be one.
- **`nearest.ts`**: the known word nearest one typed wrongly, by
  edit distance, which a command or tool says back when it doesn't
  know a word: the quest tool's actions, pi-verbs' commands.
- **`offload-exemption.ts`**: the fence's one exemption, a
  `nix-offload there` call let out to run as the person: what may go
  out, and the environment and git it is given there, through
  `nix-offload outside` where it has one.
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
- **`sandbox.ts`**: which sandbox a session asked for and the shell
  text that runs each command in it: the strict profile as landrun's
  rules, and the agent fence from `fence/fence.ts`.
- **`secrets.ts`**: the shapes a credential takes in a tool's output,
  and how one is replaced by a mark naming its kind, for the answers,
  the saved output and the stored results that hold them.
- **`single-flight.ts`**: one flight per key, which later callers
  join; work that coalesces, running once more after the run going
  for every call that came during it; and `loadOnce`, through which
  every lazy import loads its module once.
- **`spend-watch.ts`**: the bill for a period, asked of spend-watch's
  command line where it is installed, for the spend tool.
- **`spend-watch-budgets.ts`**: where every budget stands, its
  allowances in their own units, and the total across all AI spend,
  asked of `spend-watch budgets --json`, for the footer and `/budget`.
- **`stamped-read.ts`**: a file's parse kept while its inode, mtime
  and size say it is the same file, read on the thread or off it, for
  the mesh's presence listings.
- **`state.ts`**: persisting an extension's state across sessions
  and restoring it.
- **`system-program.ts`**: finding a program that runs outside the
  sandbox (bwrap, landrun, nix-offload, env, pi-spawner) only in the
  system's own profile, through steps root alone can change.
- **`tree-git.ts`**: where pi may run git outside the sandbox, and
  with which git folder: a tree only as its own files agree, and in a
  sandboxed session only in repositories the fence guards.
- **`unattended-exec.ts`**: running git and gh with nobody at the
  keyboard.
- **`void-owner.ts`**: who owns a line Joel says into the void, read
  from what he attached (a pi session, a pull request, a page, a
  window) and from the quests that claim it, for
  `scripts/void-owner.ts`.
- **`work-records.ts`**: where the work broker writes down the trees
  it cut, and which trees each session holds, for the work extension
  and for carrying a session's work.
- **`warming-carry.ts`**: an idle session's warming as kept on disk
  while no pi runs it, which a pi host warms on while the session is
  parked, and the warms it sent for the session's next start to record.
- **`write-whole.ts`**: replacing a file whole through a `.writing`
  subfolder, so a watcher of its folder hears one event a write.
