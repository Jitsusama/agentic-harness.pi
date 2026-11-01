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
  of 64 MB or more: the run has settled, you did not stop it and no
  reload is waiting. A compaction you ask for between runs rolls over
  at once.
- **Background work runs on through it.** The job host parks it for
  the fresh session, as it does across a reload, and the fresh session
  says each result. Rollovers used to wait for no job to be running,
  so a session that always waited on one never rolled over: on
  2026-11-01 a 70 MB log went nine hours and three compactions past
  the threshold.
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
- Before that too, the system messages folded into one, which
  declares the tools they left declared and removes the ones they took
  away. pi works out a resumed session's tools by replaying the system
  messages on its branch, and only the first of them declares `read`,
  `bash`, `edit` and `write`. The model never reads the fold, since pi
  builds what it sees from the compaction on.
- Labels and context edits only when what they point at is kept.
- Last, a record naming the parent log and where it ended, with
  whatever extensions carried over: the cost footer's session spend,
  so the total does not reset.

Abandoned branches and the summarised conversation stay in the parent
log. `session_recall` reads every parent from disk when it is called,
so the session's whole history is still one call away. Entry ids are
kept, and the cost ledger bills a copied turn once.

## Keeping the Model

The fresh log records the model and thinking level, but pi restores
them while it builds the fresh session, before that session's
extensions have started. When the model's provider is one an
extension registers and pi can't find it then, the session comes up
on pi's placeholder, whose provider is `unknown`, and its next call
fails with "Unknown provider: unknown" where nobody sees it. Four
sessions went dead that way on 2026-10-31, though opening their logs
afresh restored the model, so what kept it from pi then is not known.

So the rollover carries what the session ran on across the switch
itself, and sets the model and thinking level back once the fresh
session's extensions have started.

That was not enough: on 2026-11-01 two sessions rolled over with the
carry in place, came up on the placeholder anyway and logged no
model change, and a rollover with the same extensions and packages
kept its model when reproduced. So a session on no model is also set
back, before each turn, to the model and thinking level its log
chose last: on a typed prompt's `input`, which pi checks for a model
before its turn prepares, and on `before_agent_start` for a turn a
message starts, as the mesh's do.

If the model can't be set back, the session says so in the window as
an error, naming the model it had, why (pi has no such model, or its
provider has no auth configured) and `/model` to choose one, and
writes the same in its log as a `model-not-set-back` entry, so the
cause outlives the window. At startup pi says so itself.

## Logs Rolled Over Before the Fold

A log rolled over before the fold kept no system message from before
its first kept entry. Once a turn in it changed the tools, the next
restart resumed it without `read`, `edit` and `write`, and without
`bash` too until a reload. That is what two sessions came back with
after the reboot of 2026-10-22.

When such a log starts, or reloads, the workflow gives back each of
pi's built-in tools that its first compaction still declared and that
no system message has declared since, and says which. It touches only
those tools: an extension's tool comes back through pi itself.

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
- `lib/internal/session/carried-model.ts`: the model carried across
  the switch.
