# Job Workflow

Hosts background jobs: work a tool hands off so it can return at once,
whose result is said to the model when the session can take it. The
editor stays yours while the work runs, and the model hears about it
without you typing anything or it polling.

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
running after five minutes into a job of kind `shell`.

## When a Result Is Said

A result goes out as a prompt, through `pi.sendUserMessage`, and only
when nothing else is under way:

- **Not during a run.** A user message queued behind a run is what
  Escape puts back into your editor, so a result there would land in
  your draft. The outbox holds it until the run settles, which is when
  a queued message would have been said anyway.
- **Not during a compaction.** pi refuses a prompt then. Idle is pi's
  own `isIdle()`, asked each time rather than tracked from events, so
  no missed event can leave the outbox waiting forever.
- **Not while a prompt is on its way.** Between `input` and
  `agent_start` pi is still running `before_agent_start` handlers, and
  a second prompt then leaves a run Escape cannot stop. The outbox
  marks that window itself, for at most 30 seconds.

It does not use a custom message with `triggerTurn`, because pi starts
that run without `before_agent_start`, so it would go out on the base
system prompt and rewrite the whole cache twice.

Everything ready goes in one message, which opens with a line saying
nobody typed it and tags each result `[job <id>]`. A result leaves the
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
host parks its jobs, still running, with what waits to be said, under
a `Symbol.for` key on `globalThis` (`carry.ts`). The runtime the
reload starts takes them over on `session_start` with reason
`reload`, answers as the host, and says their results through its own
`pi`. Job ids carry on from where they were.

- **What is handed over is the registry itself.** A producer holds
  `Job` objects bound to it, from code the reload replaced, so the
  same objects keep working and the new runtime only rebinds where
  they speak.
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

## Limits

- **Nothing else outlives the session.** A new session, a resume, a
  fork and a quit stop every job, with the reason `session`, and drop
  whatever was waiting, since a result belongs to the conversation it
  was started in. Rolling a log over switches sessions, so it waits
  for jobs instead. A job's work should write its output somewhere
  durable if it matters beyond the session.
- **A narrow race remains.** If you press Enter in the milliseconds
  while the outbox's own prompt runs its `before_agent_start`
  handlers, pi refuses yours as already processing a prompt. pi's own
  resume after a compaction has the same window.
