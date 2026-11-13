# Host Service

The service owns versioned JSON-lines control framing and dispatch beside
H1's engine and V's Terminal. It does not implement pi's session loop,
input pipeline or screen. No unit or running host is installed yet.

- address.ts: the host's realm (MYCELIUM_REALM, else PI_HOME_REALM),
  its realm-kind key and its socket in XDG_RUNTIME_DIR.
- backend.ts: the control backend over the engine's live ownership and
  the roster. Open and adopt hold durably before the engine registers;
  a start that never registered is undone, one that registered and
  failed stays held. Close and release drop the hold only after the
  engine's close commits, closing with a reason that names the caller
  as the request does (`by`); a close of one held but not running is
  journalled here, since no end of the engine's says it. resumeHeld resumes each hold at start, keeping
  one that won't resume held and listed parked for a person to close.
  The engine it drives (prepare, start, discard, resume, abort) is H1's.
  conversationEvents is what the engine, watched once before anything
  resumes, tells the service of a change made inside pi: a conversation
  that ended itself is dropped, and one that became another (pi's new,
  fork or resume) is held in its place in one write, keeping attended,
  quest and launch. Host stop never counts as an end. Each end is one
  line in the host's journal: the conversation's mesh address, its id,
  and why, naming the viewer or caller that asked. A conversation the
  engine parked while idle is held but not running; `wake` resumes it,
  in turn with any close of it and through the rollout gate as another
  start would, and an attach to it wakes it first. A wake of one whose
  start or park failed, which leaves it held but not running, says so,
  since only a close lets it go.
- rollout.ts: the rollout gate. A host opens, adopts or resumes a
  second conversation only once every live pi (each `loaded/<pid>`
  in the install whose pid runs) loaded a harness holding 5b5b7260,
  whose mesh census judges hosted presences each on its own; an older
  one takes all but the newest as ended. A root that can't be read or
  dated counts as stale, and the refusal names each stale pid and
  root. A wake it refuses is told it stays parked and wakes at the
  next message or key once those pis reload or end, since its sender
  has nothing to fix. One conversation per host is never gated. A
  host run from a tree keeps to one. `node scripts/host-rollout.ts` prints the same
  verdict for a person.
- serve.ts: one realm-kind host's life. It takes the roster's lock,
  installs SessionHost, loads the engine, resumes what is held and only
  then listens, so a second host, an unreadable roster or a pi the
  engine refuses never reaches a socket. Stop closes the socket, parks
  every conversation as signalled and releases the lock, keeping holds.
  It watches the engine before resuming, so no end or replacement is
  missed. The engine's wakes reach the backend only while it listens.
  One before then does nothing, since the start resumes what is held;
  one once it stops is refused, saying the next start takes the
  conversation up, so the window that asked says so. The stop waits
  out any wake already resuming before it parks.
  Start first sets the package's stale-rejection net, logging under
  the host's state folder, so one conversation's reload leftovers never
  end the host and its other conversations.
- run.ts: a host as systemd runs it: kind from the command line, realm
  from the unit's environment, ready (systemd-notify, so the unit needs
  NotifyAccess=all) only once it listens, and parked on SIGTERM or
  SIGINT. Its unit's status says each start step, then "ready,
  serving N conversations" and any held but not resumed, looked at
  every 15 s and told only when it changes. When the unit sets
  WatchdogSec, a ready host pings it from its own loop four times in
  each timeout, until every conversation is parked: a loop that stops
  turning goes quiet and systemd restarts the host, while a long turn,
  which the host awaits, never stops the pings. A beat more than 5 s
  late, or half the timeout when that is less, says in the journal
  how long the loop held and how many conversations were mid-turn,
  so a stall short of a kill leaves a trace. One that kills leaves
  systemd's own "Watchdog timeout" line in the unit's journal
  instead, and the host's core with systemd-coredump.
  The engine is passed in by the program that starts it.
  Given the process's faults, it backstops an uncaught exception: one
  thrown inside a conversation goes to that conversation's screen, and
  one it can't tie to a screen parks every conversation and fails the
  run, within 45 s, so systemd restarts the host from what it parked.
- program.ts: that program, which `scripts/pi-host.ts` runs. It loads
  the host's pi from PI_PACKAGE_DIR, refused unless every host patch is
  there, starts pi's theme from the person's settings, and gives each
  conversation pi's InteractiveMode as its screen, H1's engine and the
  renewing key. It names the viewers' kitty terminal where the unit
  names none, before the theme reads it. Conversations start from the
  host's environment less systemd's hand-over and PI_PACKAGE_DIR; the
  engine pins the host's pi for their subagents. A kind, realm,
  pi install or proof it refuses exits 78, before anything is held or
  listens, so a unit naming that status stops restarting it. Once
  judged, it writes `loaded/<pid>` naming the version it runs, as
  each pi does, so pi-packages keeps that version and every one
  retired since the host started, even with no conversation open.
- settings.ts: the host's section of the package's config file,
  `host`, read once as the host starts. `collectWhenQuiet: false`
  turns off the engine's quiet collection (engine/quiet-collection.ts),
  which is on by default. A section or file it can't read is said in
  the journal and leaves the defaults, rather than refusing the start.
- restart.ts and what-starts.ts: the host restarting itself. A host
  systemd runs as its unit's main process looks every minute, from
  five minutes after it starts, whether it would start differently:
  the install's current version changes the code the host process
  loads itself (every module `scripts/pi-host.ts` reaches through
  runtime imports, with package.json and pnpm-lock.yaml), or systemd
  has read a new unit file, as a switch naming a new pi writes. Code
  only a conversation loads moves with that conversation instead
  (reload-workflow's follower). Once either differs, and every
  conversation has been idle or parked for two minutes, with no
  background work held (the engine's count of each conversation's
  job-workflow) and every screen at rest (screens.ts), it asks
  systemd to restart the unit, which parks and resumes every
  conversation. Conversations that take turns may never all rest two
  minutes at once, so once it has differed for 30 minutes the host
  looks every second and takes the first moment none has a turn
  running, still with no background work and every screen at rest;
  its journal line says which rule it restarted under. Only once
  systemctl has queued it does the stop tell
  each viewer `restarting`, just before it closes on them, so a
  refused restart says nothing. A unit file systemd hasn't reloaded
  yet asks nothing, since a restart would start the old one.
- proof.ts: a runtime's proof, which `scripts/host-prove.ts` writes
  once `pnpm test:host` has passed on that runtime with no case
  skipped. The program refuses a pi that PI_HOST_PROOF doesn't prove,
  so a pi no gate passed never runs a conversation, however its unit
  came to name it.
- pi-resolution.ts: the resolve hook `scripts/pi-host.ts` registers
  before the host's code loads, binding every `@earendil-works/` import
  made from outside the host's pi to that pi. The harness's install
  carries no pi of its own, so without it the viewer's terminal would
  find no pi-tui, or in a tree the dev copy rather than the host's.
- roster.ts: the durable realm-kind roster behind one lock per key.
  Holds are written before registration and dropped only after a close
  or release commits, or once a conversation ended itself; replace swaps
  one hold for another in one write. Stop and kill -9 keep them. A live
  or unjudgeable lock holder, a malformed lock or an unreadable roster
  refuses start. A dead holder's lock is moved aside and checked, never
  just unlinked.
  Each hold keeps the launch environment the engine derived at open,
  such as an experiment arm, for resume to replay; one naming a
  credential is refused, since keys come from the host per request.
- gateway-key.ts: the work host's one gateway key. An inherited key
  stays fixed, as the launcher treats it; otherwise the personal key is
  resolved through the dev tool and resolved again when the dev cache's
  expiry stamp moves, nears, or the gateway refuses the key.
- viewer.ts: adapts V's persistent Terminal without reproducing its
  parser, and tells the engine of each key and resize a viewer sends,
  so the quiet collection waits 30 s after one.
- protocol.ts: strict v1 control requests, replies and viewer input.
  A close or release may name its caller (`by`), for the journal.
- framing.ts: bounded UTF-8 JSON lines; only LF separates records.
- dispatch.ts: validates before engine calls and binds targeted calls
  through core/session's withSession; forwards failures to the host journal.
- server.ts: private Unix listener, bounded writes, scoped viewer input
  and disconnect cleanup. It takes over only this user's socket that
  nothing answers, as a killed host leaves, once the caller holds the
  roster lock; a live socket, a file or another user's socket is refused.
- client.ts: one-shot control requests with strict reply correlation and
  a bounded timeout. It never retries a possibly committed operation.
- join.ts: what a window's pi hands its window to as it moves in place
  (extensions/mesh-workflow/in-place.ts), run as `scripts/host-join.ts`.
  It waits, drawing nothing, until the host has the conversation open,
  and its holder then starts `mycelium attach` in the same terminal; or,
  once the move note has waited unclaimed for 10 s, it takes the move
  back through the note's claim and the window runs plain pi again, so
  the log never has two writers. With no note, claim or host for 10 s
  it runs plain pi too, and a roster host slow to start is waited on
  under one line saying so, so the window never sits frozen.

The public sessionId is always pi's stable UUID, never durable's internal
conversation id. Control operations are open, adopt, list, release, close,
abort and attach. List names each conversation busy, idle or parked;
busy while a turn runs or while background work it holds (a command,
fleet or round, or a result not yet said) outlives its turn, since a
restart would end that work. Attached viewer events are input and resize. Frames
to a viewer are output, edit, suspend, detached and restarting. The listener
owns a mode-0600 socket inside a user-owned mode-0700 directory. Viewer
output is bounded at 4 MiB pending writes; EOF detaches only the viewer.
Attach replies precede initial screen output on the same connection.
Close, release and abort over a socket require expectedHost discovery
identity. Direct internal dispatch still permits an unguarded request.

Unknown fields and operations fail closed. Credentials and arbitrary
environment maps are not accepted through this protocol. Engine failures
return a correlated generic error rather than leaking incoming data or
credential-bearing exception text. The production engine must record its
own actionable journal errors.

The listener and client are tested against an injected engine and H1's
SessionHost, not a running AgentSession. backend.ts is tested with a
fake engine; H1's real one, and the program systemd starts, follow. V supplies the ViewerBridge;
H2 does not reproduce InteractiveMode.
