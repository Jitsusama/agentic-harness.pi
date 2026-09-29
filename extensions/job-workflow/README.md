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

## Stopping a Job

`/jobs` lists what is running and what is waiting to be said. Pick a
running one and confirm to stop it; the model is told it was stopped.
The footer shows how many are running and waiting.

A producer can tell why its job's signal fired: `jobStopOf(signal)`
from `agentic-harness.pi/jobs` answers `person` for a stop from
`/jobs` and `session` for the session ending. Most work stops either
way. Work whose answer is on disk can outlive the session, and a
started review round does: the session ending stops only the watching,
and only the person stopping the job stops the round.

## Limits

- **Nothing outlives the session.** A reload, a new session, a resume
  and a quit all stop every job, with the reason `session`, and drop
  whatever was waiting. A job's
  work should write its output somewhere durable if it matters beyond
  the session.
- **A narrow race remains.** If you press Enter in the milliseconds
  while the outbox's own prompt runs its `before_agent_start`
  handlers, pi refuses yours as already processing a prompt. pi's own
  resume after a compaction has the same window.
