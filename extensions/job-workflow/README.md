# Job Workflow

Hosts background work: work a tool hands off so it can return at once,
whose result is said to the model when the session can take it. The
editor stays yours while the work runs, and the model hears about it
without you typing anything or it polling.

In the code each piece is a job. What the model and the person read
names it by what it is: a background command (a shell command handed
off), a background fleet or a watched review round, and "background
work" for them all, since the machine's glossary keeps "job" for work
run below the desktop. The tool keeps its name, `jobs`.

## How a Producer Uses It

```ts
import { findJobHost } from "agentic-harness.pi/jobs";

const host = findJobHost(pi.events);
if (!host) return refuse("background jobs need job-workflow loaded");
const job = host.start({ kind: "subagent", label: "three lanes" });
run(job.signal).then(
	(output) => job.finish({ summary: `${output.brief}\nFull output: ${path}` }),
	(error) => job.finish({ summary: String(error), failed: true }),
);
job.onDelivered(() => progress.dispose());
return `Started ${job.id}; the result will arrive on its own.`;
```

The host is found over the event bus, so a producer never imports this
extension. Stop the work when `job.signal` fires: the person stopped
it, or the session ended.

The producers in this package are subagent fan-outs, started review
rounds, CI checks being watched, away mode's nudges and
[shell-workflow](../shell-workflow/), which moves a bash command still
running after a minute into a job of kind `shell`.
[codemode-workflow](../codemode-workflow/) moves a codemode script the
same way into a job of kind `codemode`, `review_ask` moves a round it
waits on, a council or a judge, into one of kind `review`, a fleet
waited on moves into one of kind `subagent`, and the work tool's push,
rebase, resume, restack and sync into one of kind `work`. All five
share the wait in `lib/jobs/hand-off.ts`.

## A Line Typed During a Run

pi reads a line the person types during a run only once the reply has
streamed and every call in it has ended, so on 11 November such lines
waited up to 101.6 s. While one waits, pi's working line says what it
waits on ("Your message is read once bash ends"), and the extension
says on the bus that a line was typed (`lib/jobs/steer.ts`). A call
running through the shared wait then moves to a job two seconds later
rather than at the minute, so a quick call still answers for itself.
pi's own working line comes back once the line is read or the run
ends. A line queued to follow the run, or one an extension sends, such
as a mesh message, changes nothing.

## When a Result Is Said

A result goes out as a prompt, through `pi.sendUserMessage`, and only
when nothing else is under way:

- **Into a run, not behind it.** A user message queued behind a run is
  what Escape puts back into your editor, so a result there would land
  in your draft. So during a run a result is steered in as a custom
  message instead, read after the tool calls in flight: no draft gets
  it, and it starts no run of its own. On 9 November a council's end
  waited 17 minutes behind one long run. One the run didn't read is
  said again once it settles.
- **Not during a compaction.** pi refuses a prompt then. Idle is pi's
  own `isIdle()`, asked each time rather than tracked from events, so
  no missed event can leave the outbox waiting forever.
- **Not as a stopped run settles.** A compaction stops the run it
  interrupts and waits for the session to go idle, and pi starts a
  prompt sent as that run settles first. So a result a stopped run
  didn't read waits for the next tick, a second later, by when the
  compaction is under way. On 9 November two sessions said one there
  and waited about nine hours to compact, from 180k to 740k.
- **Not while a prompt is on its way.** Between `input` and
  `agent_start` pi is still running `before_agent_start` handlers, and
  a second prompt then leaves a run Escape cannot stop. The outbox
  marks that window itself, for at most 30 seconds.

It does not use a custom message with `triggerTurn`, because pi starts
that run without `before_agent_start`, so it would go out on the base
system prompt and rewrite the whole cache twice.

Everything ready goes in one message, which opens with a line saying
nobody typed it and tags each result with its id, as `[j1]`. Older
code's `[job j1]` tag and header are still recognised, since a result
sent just before a reload is seen after it. A result leaves the
outbox only once a user message carrying its tag is seen in the
session, so a send that went nowhere is sent again at the next idle
moment rather than lost, and a result is said once however often its
producer finishes it.

## Taking a Result Back

A result that stopped being true while it waited can be taken back:
`job.withdraw()` drops it if it has not gone out, and answers false
once it has. Away mode uses this, so a "keep going while the user is
away" message waiting for the session to go idle is never said after
the person came back.

## Stopping a Job

`/jobs` lists what is running and what is waiting to be said. Pick a
running one and confirm to stop it; the model is told it was stopped.
While any job runs, the footer shows an hourglass, `⧗`, with a
count once there is more than one. A finished job waiting to be said
is left off it: it is said as soon as the session is idle, and `/jobs`
lists it meanwhile.

The agent has the same through the `jobs` tool, which loads on
demand: `list` shows each job's id, kind, state and label, and `stop`
with an id stops a running one. It refuses an id the session doesn't
hold or a job that has already finished. The tool's answer is how the
agent hears of the stop, so no message follows it, and the job's end
is said on the bus at once, which lets go of the mesh's lease. A shell
job's stop kills the command's whole process group, so what the
command started goes with it. Killing the shell by hand doesn't: on 23
October a nix build, a grandchild of the shell, ran on after its shell
and direct children were killed, writing into a log a later job had
reused and holding a VM the machine queue counted free. The tool lists
and stops only its own session's jobs.

A producer can tell why its job's signal fired: `jobStopOf(signal)`
from `agentic-harness.pi/jobs` answers `person` for a stop from
`/jobs`, `agent` for a stop from the `jobs` tool and `session` for
the session ending. Most work stops either way. Work whose answer is
on disk can outlive the session, and a started review round does: the
session ending stops only the watching, and only the person or the
agent stopping the job stops the round.

## Hearing a Job End

When a job's work ends, however it ends, the host says so on pi's bus
as `jobs:finished:v1`, carrying the job's id, its kind, whether it
failed, and the `toolCallId` of the call it carries on for when a call
handed itself off. A job its closing session stops is said as failed;
one already finished is not said again. `onJobFinished(bus, listener)`
from `agentic-harness.pi/jobs` hears it. The mesh uses it to release
the heavy-work lease a bash call took, the moment the command handed
to a job ends rather than when the lease runs out.

## Through a Reload

A reload is not the session ending, and nothing a job runs notices
it. pi stops no process on a reload: it evaluates every extension
again in the same process, on the same bus, and only the old `pi` and
`ctx` go stale. So on `session_shutdown` with reason `reload` the
host parks its jobs, still running, with what waits to be said, in a
session cell (`carry.ts`): on plain pi the one `Symbol.for` key on
`globalThis` every version since v1 reads, and on a host one per
conversation, so one conversation's reload or close leaves the others'
jobs alone. The runtime the
reload starts takes them over on `session_start` with reason
`reload`, answers as the host, and says their results through its own
`pi`. Job ids carry on from where they were.

- **What is handed over is the registry itself.** A producer holds
  `Job` objects bound to it, from code the reload replaced, so the
  same objects keep working. Everything else is the new code's: it
  builds its own outbox, takes in the results still waiting and the
  ends not yet said, and has the registry report to it. Before 9
  November the old runtime's whole session was adopted, so a process
  ran the outbox of whichever version first built it, and #1101's
  steer reached no session started before it. A runtime from code
  before then can't hand off, and is adopted whole as it was.
- **A job that ends in between** has its result and its
  `jobs:finished:v1` held, and both are said once the new runtime
  has taken over, so the mesh still lets go of its lease.
- **Jobs nobody takes over within five minutes** are stopped, with
  the reason `session`, as every reload stopped them before. That is
  a reload onto code from before this, or one whose job-workflow
  failed to load. The key carries a version, and a change to what is
  handed over takes a new one.
- **A runtime pi replaced without making stale** hands its jobs
  over too. Two reloads that overlap both shut down the same old
  runtime, so the one the first starts is replaced but stays live,
  its host first on the bus. So a starting runtime asks on
  `jobs:yield:v1` for its session's jobs, and any runtime still
  holding them parks them for it. A registry from code before this
  never hears the ask; the reload workflow keeps its own reloads one
  at a time for that reason.
- **A report that comes again is dropped.** A runtime left live that
  way still holds its outbox, which never hears its report land and
  so sends it every thirty seconds until pi exits. Its sends come in
  through the session, so the live runtime turns away any job report
  the session has already shown, its history included, and no turn
  starts. Only an exact repeat of a report is dropped.
- **The registry stays the code that first built it.** A session
  that started before a registry method existed holds a registry
  without it for good, however often it reloads, so the newer code
  checks for the method before calling it. The `jobs` tool stops a job
  in a registry without `stopForAgent` through the person's `stop`: the
  work and its process group go the same way, but a message saying the
  person stopped it follows, and the tool's answer says so.

This is what keeps a 50-minute build, a fleet or heavy work waiting
its turn in the machine's queue alive through a reload: a bash
command runs under its job's signal, so stopping the job used to kill
the shell, and a job's place in the queue goes with its shell.

## Through a Rollover

A rollover carries the same conversation on in a fresh log, so its
jobs go with it. pi switches into the fresh log as it would resume any
session: `session_shutdown` with reason `resume` and the fresh log as
its target, then a new runtime, as on a reload. When that target's
header names the closing session's log as its `parentSession`, the
host parks its jobs for the fresh session's id rather than stopping
them, and the fresh session takes them over on `session_start` with
reason `resume`. A resume into any other log stops them, as before.

The mesh lets go of a session's heavy-work leases as it shuts down,
reload or rollover, so a carried job runs on without one.

## Through a Move

A move to a host (`/host`, or a wave) ends the pi and has the host
open its log, and a job used to die with the pi. So a move waited out
every job, and on 12 November a wave moved none of seven sessions,
each always running a command of its own.

Now a producer whose work lives outside the pi says how another
process takes it up, through its spec's `carry`, and only the jobs
without one hold a move. `/host` and a wave name those by kind and id:
`waiting first, as a fleet is out (j3: k7-read)`. When the pi quits
with a move note naming itself and a host, the jobs that can be
carried are let go unstopped, and a `job-carried` entry in its log
names each, with the results not yet said. The host starts the
conversation as `startup`, takes each job up under its own id, says
the waiting results, and leaves a `job-carried-taken` entry so a later
start doesn't take them again. A job taken up can be carried again.

- **Carried:** bash calls pi started itself, which keep their output,
  status and pid on disk (see
  [shell-workflow](../shell-workflow/#through-a-move)). The host says
  each one's end in the words its own pi would have. A call whose
  shell is gone with no status is said as lost, with its last lines,
  and is never run again.
- **Handed on:** review rounds, CI watches and background
  fleets (see
  [subagent-workflow](../subagent-workflow/#through-a-move)).
  Any other kind is
  offered on the `jobs:take-up:v1` bus (`lib/jobs/take-up.ts`) to
  the extension that answers for it, which watches on under the
  job's id (see
  [review-integration](../review-integration/#waiting-through-a-move)).
  A kind nobody answers for ends saying it can't be taken up.
- **Holding:** calls `pi-spawner` started, and calls started before
  this ran; a fleet from a session with no id; a review watch
  that names no target; a model
  retry; a reload.
- A signal ends the pi without its children, so a pi signalled during
  its move carries nothing.
- **Released:** a hosted conversation moving back to plain pi (a
  release, or item 11's rollback) carries the same way: in a host its
  note names the host's process, and its close is its own quit. The
  host spares each carried command as it reaps what the conversation
  started, by a `.carried` mark beside the command's kept files, and
  the plain pi opened on the log says its end.

## Through a Host's Restart

A shared host restarting itself onto new code waited out every
background job, and on 13 November neither work host restarted for
hours, since each always had a command running. Now the host tells
each conversation on its bus (`agentic-harness:host-restarting`) just
before it stamps the stop signalled, and job-workflow carries what it
can as a move does, recording only the rest as cut off. It says on the
bus what went (`jobs:carried:v1`), so the host can keep each bash
call's shell alive through its stop (see
[the host engine](../../host/engine/README.md)), and the next host
takes them up as a move's. Taking one up says `jobs:taken-up:v1`, so
mesh-workflow claims a heavy command's lease again until its end.

- **Carried:** bash calls, where the host has a jobs cgroup to keep
  them in. `holds(carriable)` names every other running job, which
  still holds the restart: fleets, codemode, review rounds.
- **Lost:** a crash or a `kill -9` of the host carries nothing; the
  conversation comes back cut off, and the next host ends what was
  left as before.

## When the Machine Ends a Session

pi resumes nothing on its own. A session restored after a reboot sits
at its prompt, though its run was cut off or a job it waited on died
with it, and after one reboot three sessions sat idle that way until
another asked them to carry on.

A signal, SIGTERM or SIGHUP, is what tells the machine ending a
session from the person ending it. When one ends the session with a
run or a running job under way, a `job-session-cut-off` entry records
which, and when the session is next started or resumed it is given a
turn of its own: when it ended, whether mid-run, and which jobs died
and will never report. An uncaught error ends pi with no signal, so
the record is left as it dies too, through the crash record's slot
(`lib/internal/session/crash-record.ts`). A session killed outright
writes nothing, so a log that stops on a tool call or its result is
read the same way. A prompt after the record, the person's or that
turn's, takes it up, so the turn comes once. The turn asks the session
to tell its orchestrator, once, that it came back and what it carries
on with.

- A run stopped with Escape has settled before the session ends, so
  it is never read as cut off.
- A log from before this ran can't tell a signal's abort from Escape,
  so it gets no turn.
- A session killed outright while idle and waiting on a job is missed:
  its log ends where a finished run's would. One that an uncaught
  error ends is not: on 11 November five lanes waiting on jobs died so
  and sat idle for two hours before this.
- In a host no conversation hears an uncaught error: the host listens
  for the process itself.
- Closing a terminal mid-run sends SIGHUP, so that session too is given
  a turn when it is reopened.
- In a multi-session host a signal reaches the process, so every
  conversation it runs, and no conversation listens for one. The host
  stamps each conversation it stops `signalled` on that conversation's
  bus before its shutdown runs, and one the person closed `closed`
  (`SESSION_STAMP_EVENT`, `lib/core/session`); only `signalled` leaves
  the record.

## Limits

- **Nothing else outlives the session.** A new session, a resume of
  another log, a fork and a quit that isn't a move stop every job, with the reason
  `session`, and drop whatever was waiting, since a result belongs to
  the conversation it was started in. A job's work should write its
  output somewhere durable if it matters beyond the session.
- **A narrow race remains.** If you press Enter in the milliseconds
  while the outbox's own prompt runs its `before_agent_start`
  handlers, pi refuses yours as already processing a prompt. pi's own
  resume after a compaction has the same window.
