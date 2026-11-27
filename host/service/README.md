# Host Service

The service owns versioned JSON-lines control framing and dispatch beside
H1's engine and V's Terminal. It does not implement pi's session loop,
input pipeline or screen. No unit or running host is installed yet.

- address.ts: the host's realm (MYCELIUM_REALM, else PI_HOME_REALM),
  its realm-kind key and its socket in the login's runtime folder
  (AGENTS_RUNTIME_DIR, else XDG_RUNTIME_DIR, else a Mac's cache folder).
- attach-waits.ts: what the journal says of a window's attach that
  waits past ATTACH_SLOW_MS: the step it is on, each later step that
  holds it again, how it ended (answered, or refused and why), and the
  clock server.ts's first-frame lines share.
- backend.ts: the control backend over the engine's live ownership and
  the roster. Open and adopt hold durably before the engine registers;
  a start that never registered is undone, one that registered and
  failed stays held. Close and release drop the hold only after the
  engine's close commits, closing with a reason that names the caller
  as the request does (`by`); a close of one held but not running is
  journalled here, since no end of the engine's says it.
  The engine it drives (prepare, start, discard, resume, abort) is H1's.
  Host stop never counts as an end. A conversation the
  engine parked while idle is held but not running; `wake` resumes it,
  in turn with any close of it and through any gate a second
  conversation passes, as another start would, and an attach to it wakes it first. A wake of one whose
  start or park failed, which leaves it held but not running, says so,
  since only a close lets it go.
  A rollback's release (scripts/host-release.ts) never cuts a run: a
  busy conversation lets go only between runs (mesh-workflow
  moving.ts), what was queued behind its run waits in its log for
  plain pi (E27), and away mode holds its send-back meanwhile (E28).
- conversation-events.ts: conversationEvents, what the engine, watched
  once before anything resumes, tells the service of a change made
  inside pi: a conversation that ended itself is dropped, and one that
  became another (pi's new, fork or resume) is held in its place in one
  write, keeping attended, quest and launch. Each end is one line in the
  host's journal (endedLine): the conversation's mesh address, its id,
  and why, naming the viewer or caller that asked.
- resume-held.ts: what a start does with each hold it begins with.
  resumeHeld resumes them alone until one has resumed, then
  RESUME_AT_ONCE at a time, in the order `heldOrder` keeps, which a
  window or wake brings one forward in. One that won't resume stays
  held and listed parked for a person to close, apart from one whose
  session file is gone, which nothing could resume: it is dropped, and
  the journal's ready line names it.
- rollout.ts: what a second conversation passes, and the root a host
  runs. A host admits every conversation unless given a gate: a child
  refuses a second (child.ts), and tests give their own. The census
  gate it once held, which waited for every live pi to load a harness
  holding 5b5b7260, was retired on 26 November once every live pi
  held it.
- serve.ts: one realm-kind host's life. It takes the roster's lock,
  installs SessionHost, loads the engine, listens, then resumes what is
  held, so a second host, an unreadable roster or a pi the engine
  refuses never reaches a socket. A window, wake, close or abort of one
  the start has yet to resume brings it forward and waits for that
  resume (resume-held.ts's `heldOrder`), so a person's conversation is back
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
  SIGINT. Its unit's status says each start step, then "ready: loaded
  N, parked M, dropped K" and any held but not resumed (one whose
  resume failed counts there, never as parked), looked at every 15 s
  and told only when it changes. When the unit sets
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
- systemd.ts: how run.ts tells systemd each of those: a step's ask for
  more time, the ready and the read-back of the unit's ActiveState that
  says systemd took it (told at most ten times in all while the unit
  reads activating), the watchdog's pings and the unit's status. Each
  telling is a systemd-notify sent from the host's own cgroup and killed
  once its time is up (a watchdog ping's is one beat), and the read-back
  is a systemctl given 5 s, so none that hangs can hold the start, a
  step or the stop.
- status.ts: what run.ts says of the host in words: each start step,
  each resume's phase times, the ready count and the journal's names
  of dropped holds, and the stopping status. The words change for the
  people reading them, apart from when the host says them.
- hold-watch.ts: what holds the loop, said from a worker thread while
  systemd watches the host. The loop ticks a shared counter each
  second; once it stands still 5 s, the thread reads the main thread's
  state, the kernel function it waits in, its CPU and disk faults, and
  the process's swap from /proc, and writes them straight to the
  journal's descriptor, since a held loop carries no write: as the hold
  passes 5 s, every 30 s it lasts, and once it ends. Running (R) tells
  JavaScript or the collector at work from waiting on disk or a lock
  (D, with where). A hold 30 s long with the thread last seen running
  is profiled once for 3 s through the inspector: the journal names the
  busiest frames and the busiest one's callers, then where the profile
  is kept, in the host's state folder under held/, the newest three up
  to 16 MB each, each file written readable by its owner alone, to open
  in a browser's profiler. Where it spun is said before the disk is
  asked, so a disk that never answers can't take it.
  The engine is passed in by the program that starts it.
  Given the process's faults, it backstops an uncaught exception: one
  thrown inside a conversation goes to that conversation's screen, and
  one it can't tie to a screen parks every conversation and fails the
  run. Any stop ends within the time stop.ts gives it.
- stop.ts: how a host's stop ends. It parks for three quarters of the
  stop limit its unit names in PI_HOST_STOP_USEC, in microseconds as
  systemd counts them (112.5 s of core.nix's 150 s), or for 45 s of
  systemd's default 60 s where it names none, in whole milliseconds and
  never past the 24.8 days a timer can wait, so systemd's infinity
  never ends a stop at once. A park still awaiting its conversation's
  work then is left, and the journal says how long the stop really
  took beside its bound, since a busy loop comes to it late, and names
  each conversation not parked, which the next host resumes from its
  store as it would after a kill and notes beside that resume.
- stop-backstop.ts: what ends a stop whose loop never comes back to its
  bound, which is a timer on that loop: at 04:33 on 18 November one ran
  on a CPU for 117 s of 150 and systemd killed it with nothing said. A
  worker thread, armed as each stop begins and told each second what is
  still unparked, ends the host at seven eighths of the stop limit
  (131.25 s of 150), and at least 5 s past the loop's bound, marking
  what it last heard was unparked as stop.ts would and saying so in a
  line of its own. It ends it with SIGKILL,
  the one end a thread can give its process that a held loop can't put
  off, which systemd reads as a failed stop, as it reads its own kill. A stop that
  ends on the loop disarms it, since the host exits then. It is armed
  from the loop's own SIGTERM handler, so a loop already held as the
  stop comes is left to systemd as before; a unit that never kills,
  under systemd's infinity, arms none; and a thread that can't start
  says so.
- program.ts: that program, which `scripts/pi-host.ts` runs. It loads
  the host's pi from PI_PACKAGE_DIR, refused unless every host patch is
  there, starts pi's theme from the person's settings, and gives each
  conversation pi's InteractiveMode as its screen, H1's engine and the
  renewing key. It names the viewers' kitty terminal where the unit
  names none, before the theme reads it. Conversations start from the
  host's environment less systemd's hand-over, PI_PACKAGE_DIR and the
  unit's stop limit; the
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
  has read a new unit file, as a switch naming a new pi writes, or
  its heap holds more than half of what V8 allows, so a stop still
  parks quickly rather than running into the limit. Code
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
  journal once an hour, and nothing is ended for it, short of a heap
  running out. Past three-fifths of V8's limit the host takes the
  first moment no conversation has a turn running, whatever background
  work or screens hold, naming what it ends and letting no held wake
  through. While turns run it drains itself, as a drain asked by hand
  does, so each conversation parks as its turn ends and a wake waits
  for the next host: on 20 November a pressed host waited 52 minutes
  for such a moment as wakes kept starting turns. While the drain
  stands the heap counts as pressed, so its own parks never let its
  held wakes through; it lifts once the heap is under half, and
  another difference, such as a moved install, then waits under the
  ordinary rules. A turn running since the drain began that still
  runs half an hour on lifts it once the heap is under three-fifths,
  so one turn that never ends can't hold parked work; pressed again,
  it drains again. A call holding the restart once the turns end, or
  a turn begun since, lifts nothing. Still pressed past that half
  hour while a turn runs, it stands, saying once an hour which turn
  from before the drain holds it, or that turns begun since do. A
  turn's busy time counts from its run's start: pi's retries and
  continues start runs of their own, so each counts as begun anew.
  A drain standing by hand before the heap was pressed is left to
  its asker; one asked while the heap's stands lifts with it. One
  lifted by hand while the heap is still pressed is started again at
  the next look. Past
  three-quarters it restarts at once, turns and all, since on 18
  November a host whose councils held its restart ran out
  of heap and ended everything anyway. The heap is read as the last
  major collection left it, so garbage not yet collected never ends a
  turn. Any restart but one at three-quarters also waits while the
  probes the unit names in PI_HOST_RESTART_WAITS_ON say a call is on
  or a meeting is near (quiet.ts), or can't tell, looking each minute
  and saying once why it waits. Only once
  systemctl has queued it does the stop tell
  each viewer `restarting`, just before it closes on them, so a
  refused restart says nothing. A unit file systemd hasn't reloaded
  yet asks nothing, since a restart would start the old one. A Mac's
  host is a launchd job (its parent launchd, its XPC_SERVICE_NAME a
  Label naming a pi host), which no systemctl restarts: under the same
  rules it stops as a stop signal would and exits 75, which launchd
  starts again, and only its install and heap move it. A stop signal,
  even one come while it resumes its conversations at the start,
  while it parks to restart, or a second, makes a stop that parks
  within its bound exit 0, which launchd leaves down, and the journal
  says when one cut a restart short. The bounds count from the first
  signal, as launchd's timeout does, so a slow start leaves the park
  less time. One come earlier, while node loads the host or reads its
  settings, still kills it by signal, which launchd starts again. A
  park so held
  that the backstop or launchd's own timeout kills it dies by signal,
  which launchd starts again; so its job names the same limit in
  PI_HOST_STOP_USEC as in its ExitTimeOut, as core.nix's launchd
  module does, since without it the 45 s default outlasts launchd's
  own 20 s. It says as it starts which way it
  decided, and keeps its Label from its conversations, so a pi-host a
  tool starts never passes for the job. A Mac has no /proc, so what
  its conversations' tools leave running is never ended, and no
  carried call is killed on its pid's word alone; it says so as it
  starts.
- quiet.ts: the probes a host's restart waits on, from the unit's
  PI_HOST_RESTART_WAITS_ON, a JSON list of `{ "while", "run" }`. A
  probe exiting 1 is clear, as a-call-is-on and a-meeting-is-near
  exit; any other exit holds the restart, and one that won't run or
  answer within 15 s means it can't tell, which holds it too.
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
  has its own folder in the login's runtime folder (`pi-compile/host`),
  a private tmpfs no fenced command sees, so a flush waits on no disk;
  without one, as on a Mac, in the harness's state (`host-compile`),
  which the fence keeps read-only. A
  host removes its own earlier installs' folders as it starts. It is
  flushed once the host serves, since a killed host never reaches the
  exit where node would write it. A cache that can't be had is said
  in the journal, and the host starts without it.
- roster.ts: the durable realm-kind roster behind one lock per key.
  Holds are written before registration and dropped only after a close
  or release commits, once a conversation ended itself, or at a start
  that finds its session file gone; replace swaps one hold for another
  in one write. Stop and kill -9 keep them. A start waits up to a
  minute on a live or unjudgeable lock holder, looking each second,
  since a restart can start it while the last host still parks; past
  that it refuses, naming the holder's pid and the wait, and never ends
  the holder itself. A malformed lock or an unreadable roster refuses
  start at once; a lock missing or empty, as one let go or not yet
  written, is looked at again within the minute. A dead holder's lock
  is moved aside and checked, never just unlinked, and one gone before
  it can be moved is simply taken.
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
  A request naming a conversation a child runs is asked of the child,
  and a window attaching to one is handed to the child as bytes. A
  window whose attach names the `direct` feature (protocol.ts
  `DIRECT_ATTACH`) is instead answered with the child's `socket`, once
  the host has reached it, and attaches there itself; its keys and
  frames then never cross the host's thread, and a host restart leaves
  it attached. A child the host can't reach is said as
  `child_unreachable`, as for any window.
- children.ts: the conversations child processes run, as the host
  routes to them: each child's socket and identity, the request as the
  child takes it under its own name, and lists naming each conversation
  once, whichever thread runs it.
- child-requests.ts: reaching a child's socket and reading the one
  answer a request gets; a child answering as another process, or not
  at all, is said as `child_unreachable`. A begin the host's own work
  left too little time for a child to start and answer (20 s for its
  first ask, `LEAST_FIRST_ASK_MS`, past the watch kept back after it)
  is refused as `begin_too_late` before any child starts, with words
  asking for a wait rather than an ask at once.
- unsettled-open.ts: the `open_unsettled` refusal's words, naming the
  conversation a child runs though it gave no answer in time, written
  by the host and read by the spawn that asked, which attaches to it.
  The error's shape is strict, so the id travels in its words, and only
  a UUID is read from them. Only the host's own stands: a child that
  says it of itself is stopped, and its open failed as
  `operation_failed` in the host's words, which name no conversation.
- child-units.ts: where each child runs: an instance of the template
  unit `pi-conversation-KEY@SLOT.service` core's host.nix writes, and
  its slot in `pi-host/KEY.d/`, SLOT.json naming the roster entry it
  resumes, SLOT.sock where it listens and SLOT.d/ for its own use.
- spare.ts: a warm spare child, started before any conversation wants
  it. Its slot holds `{"spare": true}`: it loads the host's pi, builds
  pi's session services once for an empty folder of its own (on 24
  November 6.3 to 13.6 s cold, then 0.4 to 0.5 s in the same process
  for another folder), collects, looks once more at its install,
  writes SLOT.warm holding the version it runs and waits for its slot
  to name what it starts as. A take renames SLOT.warm to SLOT.taken
  and a leave unlinks it, so only one lands. It leaves, exiting 0,
  when its install's host code moves, past 200 MB once collected,
  when a take names nothing within 60 s, or once it has waited an
  hour untaken, so one whose host is gone for good holds nothing past
  then.
- stale-child.ts: a child rolling onto new code. A child never
  restarts itself, so it keeps the host code it started with; on 22
  November 15 children ran host code 34 hours old. Every five
  minutes it asks its install (what-starts.ts `installMovesFrom`, as
  restart.ts does) whether the host code there differs, and once it
  does, says so in the journal and marks its host stale for good
  (`SessionHost.roll`). Its conversation then parks at its next quiet
  moment, idle time aside, unless a window views it
  (`Host.rolling`), and the next wake starts a fresh child on current
  code. Its wakes are held as a drain's are (`SessionHost.holdsWakes`),
  so a woken one waits for that fresh child, but only while no window
  views it, since a window keeps the child running.
- child-watch.ts: watching one child on a connection kept open: its
  first answer names who it is and its conversation, then a line for
  each state, each new id the conversation takes, and its ending. A
  line it can't read ends the watch as failed.
- child-starvation.ts: judging a child past its time to listen or to
  answer its watch, which nobody waits on: starved by a busy machine,
  and waited on, or stuck, and given up.
- child-supervisor.ts: the host starting a child for a conversation it
  resumes or a caller opens, holding a route to it from the child's
  watch, moving it as the conversation becomes another and letting it
  go with the slot as the child ends. A child that never listens or
  refuses its first request is stopped. A wake, or a resume a window
  or a message asks for, past its 60 s waits on a child that has had
  under 20 s of CPU, as systemd accounts it, for up to 10 minutes,
  since a busy machine starves a start rather than wedging it; one
  that gains under 0.25% of a core over a whole 60 s waits on
  something else, and is given up then; one whose CPU systemd never
  says is given up at 120 s. Once it listens, it is judged the same
  way on answering its watch, as it builds its conversation, by the
  CPU it gains while watched, within the same 10 minutes. Its journal
  says as it starts waiting and as it listens or answers. Three keep a 60 s bound to listen and are refused
  at it without asking systemd: a caller's open or adopt, and a host
  starting's take-ups and resumes, since every child start waits its
  turn at one gate (start-gate.ts), so a starved child there would
  hold those behind it. A start's resume
  that a wake pulled forward is bounded too; given up, that wake
  resumes it itself and waits while it starves. A host starting takes up the
  children an earlier one left running, and a host stopping leaves
  them, so stopping the host halts none of its children's
  conversations. Where its policy says, it keeps one warm spare
  started 10 s after its adopt and after each take, and never sooner,
  through the gate behind every start already waiting, holding its
  turn until warm (said as "a spare was seen warm", or at 120 s as "a
  spare held its turn"), or until its unit ends cold ("a spare ended
  before it warmed"), which a
  start given its turn takes in place of starting a unit, said as "took a
  warm spare" in the journal; a spare still warming is passed over,
  and one whose version its install has moved on from is passed over
  and stopped, said as "passed over a warm spare", so no wake lands
  on code a fresh start would no longer run.
  One that leaves untaken is let go and replaced, whether the check or
  a take finds it gone, and one with no warm mark 120 s after its start
  is stopped, said as "stopped a spare that never warmed"; one seen
  warm once never is, though its mark goes as it leaves. Once three
  in a row leave within 300 s of starting the host keeps none until it
  restarts. A host stopping stops its untaken spare, since it runs no
  conversation, and a host taking up its last one's slots stops every
  spare still left untaken, since it may run old code. To halt the children's
  conversations too, stop their units:
  `systemctl --user stop 'pi-conversation-KEY@*'`; each stays held, so
  a host starting resumes it, and a running one starts it again at a
  wake when the child parked it naming the host's wake file. Before rolling back to a host without
  children, which neither takes them up nor knows they run, so would
  resume their conversations beside them, stop the host first and
  then their units: a running host starts a child again at its
  conversation's next wake. Before rolling back to a host with children
  but no spares, set `"spares": false` and wait for the journal to say
  "stopped the spare, since the policy keeps none" (within a minute),
  or that host takes it up as a child that never listens, and holds
  its resumes back a minute. The host runs a
  conversation itself only once every child that ran it has gone and
  its own slot is free, unless a child there became another
  conversation, as the host heard it or as a child taken up says, and
  the roster's write of what it became has landed (`left`), one that
  fails being reported and let go; while one still runs, the resume
  fails.
- start-gate.ts: the one gate every child start passes, whatever asked
  for it, letting `STARTS_AT_ONCE` (2) between their unit's start and
  their first answer at once, since many building their conversations
  together on a loaded machine were each judged slow and started
  again. Those someone waits on (a wake, an open, an adopt, or a
  start's resume a wake comes to wait on) go first, the rest in the
  order they asked. A turn is given back once its child answers,
  fails or is given up, or once held its listen and answer times
  together (120 s), so starved children let two more start each time
  rather than holding every other start. A wait its caller's time,
  the host's stop or a give-up ends leaves the queue at once; a begin
  whose time runs out there is refused as too late, as one weighed
  too late is. The journal says a start that waited over 2 s for its
  turn and each turn given back unanswered.
- child-policy.ts: which conversations move to children, read from
  `host-service/KEY/children.json` as it changes, never per decision:
  `{"v":1,"sessions":[ids]}` moves those as they next wake or start,
  and `"all":true` moves every one and every open. `"spares":true`
  keeps one warm spare child (spare.ts) for the next resume or open
  to take, off unless said, and only while the file moves something.
  A missing file
  moves nothing, so deleting it or emptying its list moves them back;
  one it can't read keeps the last it read, so write it beside and
  rename it into place. A folder it can't watch moves nothing, and
  says so, rather than failing the host.
- child-hosting.ts: the routes, supervisor and policy put together for
  serve.ts. A child that ends parked or failed leaves its conversation
  held and resting, its wake watched by the host again, so no process
  runs for a parked conversation. That needs a child's park marker to
  name the host's own wake file, as `parked.wakeFile` gives it under
  the host's key; one naming another is woken by nothing until a
  window attaches. One whose child failed while its last state was
  busy, as a child killed mid-turn leaves it, is then woken at once,
  as a message wakes it, so the turn carries on as a host's restart
  carries one on, rather than waiting for a window. It is woken so at
  most once in `WOKEN_AGAIN_AFTER_MS` (10 minutes), and at most
  `WAKES_A_DAY` (3) times in a day of one host's run, as the host
  keeps the count in memory, so a turn that kills its child each time
  asks the model again only so often; past either, it rests, and the
  journal says so. One whose child dies as its close, release or
  abort is asked, whether a window asked it through the server or the
  host asked it itself, rests too: until `END_ASKED_HOLDS_MS` (90
  seconds) after the child agrees, and until the child ends when it
  can't be reached or its asker hangs up first; an abort the child
  took leaves its later death its own. A child stopped with SIGTERM
  (`systemctl --user stop` on its unit) parks, and stays parked; only
  one killed outright (SIGKILL, the kernel's out-of-memory killer) or
  crashed mid-turn is woken, so to stop a busy one for good, close it
  or stop its unit, not `kill -9` it. A wake that doesn't land is
  said, and reported too unless the host is stopping, which refuses
  every wake as it should.
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
host, until the restart passes its settle ceiling and waits for a gap,
when those held wake and the rest go through at once, said once in the
journal, until the restart is asked or the host stops; a window opening or a viewer typing still wakes it, and that
one isn't drained again; and a heavy run (a build, a check, a suite,
`host/engine/heavy.ts`) holds the restart, carried or not. It answers the
counts busy, idle and parked and the heavy runs going, and the journal
says who asked. Attached viewer events are input, resize, edited and
leave, which a viewer sends as its window is closed by hand. Frames
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
