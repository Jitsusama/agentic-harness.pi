# Rollover Workflow

Keeps a long session light. After a compaction, a session whose log
has grown past 64 MB carries on in a fresh log that holds only what
the model still sees, with the old log named as its parent.

## Why

pi holds every entry of a session's log in memory for as long as the
session runs, compacted or not, and reads all of it again on every
resume. A compaction has already turned most of that into history the
model never sees. One long session's 319 MB log held 412 MB of heap;
rolled over, its fresh log was 24 MB and held 37 MB, and it opened in
84 ms instead of a second.

Nothing the model reads changes: the fresh log builds the same context
from the same compaction, with the same model and thinking level, so
the provider's prompt cache carries on too.

## When

- **By itself,** at the first still moment after a compaction of a log
  of 64 MB or more: the run has settled, you did not stop it, no
  background job is running (switching logs would end it) and no
  reload is waiting. A compaction you ask for between runs rolls over
  at once.
- **On asking,** with `/rollover`, whatever the log's size, once the
  session has compacted at least once.

Only a session somebody sits at rolls over by itself; a subagent or a
print run is short. `PI_ROLLOVER=off` turns it off.

You see one line saying the sizes before and after. The session goes
on where it was.

## What the Fresh Log Keeps

- Everything from the last compaction's first kept entry on, which is
  all the model sees.
- Before that, every extension's own state, the model and thinking
  changes and the session's name, in their order, so each extension
  starts as it would on a resumed session.
- Labels and context edits only when what they point at is kept.
- Last, a record naming the parent log and where it ended, with
  whatever extensions carried over: the cost footer's session spend,
  so the total does not reset.

Abandoned branches and the summarised conversation stay in the parent
log. `session_recall` reads every parent from disk when it is called,
so the session's whole history is still one call away. Entry ids are
kept, and the cost ledger bills a copied turn once.

## Carrying State Over

An extension that keeps a figure in memory rather than in the log
listens for `session:rollover-carry:v1` on the bus and puts what it
needs under its own name in the payload's `carried`. When the fresh
log starts, `carriedBy(branch, name)` from
`lib/internal/session/rollover.ts` hands it back.

## Files

- `index.ts`: when to roll over, and the `/rollover` command.
- `lib/internal/session/rollover.ts`: what the fresh log holds, the
  record, and reading the parents back.
