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
  A rollback's release (scripts/host-release.ts) never cuts a run: a
  busy conversation lets go only between runs (mesh-workflow
  moving.ts), what was queued behind its run waits in its log for
  plain pi (E27), and away mode holds its send-back meanwhile (E28).
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
  installs SessionHost, loads the engine, listens, then resumes what is
  held, so a second host, an unreadable roster or a pi the engine
  refuses never reaches a socket. A window, wake, close or abort of one
  the start has yet to resume brings it forward and waits for that
  resume (backend.ts's `heldOrder`), so a person's conversation is back
  first and none resumes twice; a list shows those still to come as
  parked. The host is ready only once the last has resumed. Stop closes
  the socket, parks every conversation as signalled and releases the
  lock, keeping holds. It watches the engine before resuming, so no end
  or replacement is missed. The engine's wakes reach the backend only
  while it listens.
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
  instead, and the host's core with systemd-coredump. A beat that late
  pings at once, even with the last ping's end still unread, so a hold
  the loop recovers from never costs the host its next beat.
- hold-watch.ts: what holds the loop, said from a worker thread while
  systemd watches the host. The loop ticks a shared counter each
  second; once it stands still 5 s, the thread reads the main thread's
  state, the kernel function it waits in, its CPU and disk faults, and
  the process's swap from /proc, and writes them straight to the
  journal's descriptor, since a held loop carries no write: as the hold
  passes 5 s, every 30 s it lasts, and once it ends. Running (R) tells
  JavaScript or the collector at work from waiting on disk or a lock
  (D, with where).
  The engine is passed in by the program that starts it.
  Given the process's faults, it backstops an uncaught exception: one
  thrown inside a conversation goes to that conversation's screen, and
  one it can't tie to a screen parks every conversation and fails the
  run. Any stop ends within 45 s, inside systemd's 60 s stop timeout:
  a park still awaiting its conversation's work then is left, and the
  journal names each conversation not parked, which the next host
  resumes from its store as it would after a kill.
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
- live-heap.ts: the heap a host weighs itself by, read as each of
  V8's full collections ends, since the used heap between them counts
  garbage the next collection frees. It is the lower of the last two,
  so a turn's passing data, live in one collection, isn't taken for a
  climb, and it counts its readings, one for several collections Node
  delivers at once (`fullCollectionsIn`), since a reader waits for two
  fresh ones.
- heap-mark.ts: what the heap tiers weigh growth from, the gap tier's
  lowest and the urgent tier's floor, set once two fresh readings have
  come after the first look. A park keeps the marks it parked under and
  its wake puts them back, so heap a wake refills isn't growth; a close
  lets them go; a conversation the session host numbers anew woke
  between two looks. After a wake the marks don't fall until two fresh
  readings have come past ten minutes on, so a reading from before it
  can't stand for room; a wake inside that while doesn't lengthen it,
  and one after waits only for two fresh readings of its own, so wakes
  every few minutes can't hold the marks up all day. A wake of one parked, or begun again, before
  the marks were set lets the gap tier's mark rise with the readings
  for that while, the one ending it included; the floor never rises so.
- one-line.ts: a label a model wrote, made one journal line, so a line
  break, NUL, escape or format character in a job's label, or in who a
  control request says asked, can't forge or reorder a host's line, and
  a long one is cut short of where journald would split it, never
  between a character's two halves; `oneLineOf` joins a list of them,
  naming the first 20 and counting the rest.
- restart.ts and what-starts.ts: the host restarting itself. A host
  systemd runs as its unit's main process looks every minute, from
  five minutes after it starts, whether it would start differently:
  the install's current version changes the code the host process
  loads itself (every module `scripts/pi-host.ts` reaches through
  runtime imports, with package.json and pnpm-lock.yaml), or systemd
  has read a new unit file, as a switch naming a new pi writes, or
  its heap holds more than half of what V8 allows, so a stop still
  parks quickly rather than running into the limit. Past 70% of the
  limit, background work no longer holds the restart, and it looks
  every second for the first moment no conversation has a turn
  running and every screen is at rest; past 80% it restarts at once,
  since running out ends every turn and job anyway (16 November,
  20:44). Both weigh the heap V8 kept after its full collections
  (live-heap.ts). The 70% tier acts only once the heap has grown 15%
  of the limit from the lowest any look has read since the host's
  first, not counting what a park freed, since a wake fills it again
  (heap-mark.ts), so a host its resumed conversations fill doesn't
  restart at every first look or every wake; the 80% tier once it has
  grown 5% from a floor no wake of one parked before the marks lifts,
  so a host that starts that full restarts only as it climbs, though a
  refill alone that high restarts it too, which its journal line says.
  A heap past 70% that neither restarts says why once an hour, as does
  one a running turn or a screen in use holds, and a refused heap
  restart is tried again after 1, 2, 4 s and on, up to a minute, its
  journal naming what it would end once and each retry only that it
  asks again. Code
  only a conversation loads moves with that conversation instead
  (reload-workflow's follower). Once any of these holds, and every
  conversation has been idle or parked for two minutes, with no
  background work held (the engine's count of each conversation's
  job-workflow) and every screen at rest (screens.ts), it asks
  systemd to restart the unit, which parks and resumes every
  conversation. Conversations that take turns may never all rest two
  minutes at once, so once it has differed for 30 minutes the host
  looks every second and takes the first moment none has a turn
  running, still with no background work and every screen at rest;
  its journal line says which rule it restarted under. Background
  work is what a restart would end (fleets, codemode, review rounds),
  since bash calls are carried to the next host (see the engine's
  README); work holding a restart past the ceiling is named in the
  journal once an hour, and nothing is ended for it. Only once
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
- compile-cache.ts: node's compile cache, which `scripts/pi-host.ts`
  enables before anything else loads, so a start reads back what an
  earlier start of the same install compiled rather than compiling
  pi's and the harness's modules again. Each realm, kind and install
  has its own folder in the harness's cache (`host-compile`), and a
  host removes its own earlier installs' folders as it starts. It is
  flushed once the host serves, since a killed host never reaches the
  exit where node would write it. A cache that can't be had is said
  in the journal, and the host starts without it.
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
abort, drain and attach. List names each conversation busy, idle or parked;
busy while a turn runs or while background work it holds (a command,
fleet or round, or a result not yet said) outlives its turn, since a
restart would end that work. Drain, with `on`, readies the host for a
restart when its conversations' turns overlap so no moment comes with none
running: each parks as soon as its park rule holds, idle time aside; a
wake through its file or a steer waits on disk for the lift or the next
host, while a window opening or a viewer typing still wakes it, and that
one isn't drained again; and a heavy run (a build, a check, a suite,
`host/engine/heavy.ts`) holds the restart, carried or not. It answers the
counts busy, idle and parked and the heavy runs going, and the journal
says who asked. Attached viewer events are input and resize. Frames
to a viewer are output, edit, suspend, detached and restarting. The listener
owns a mode-0600 socket inside a user-owned mode-0700 directory. Viewer
output is bounded at 4 MiB pending writes; EOF detaches only the viewer.
Attach replies precede initial screen output on the same connection.
Close, release, abort and drain over a socket require expectedHost discovery
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
