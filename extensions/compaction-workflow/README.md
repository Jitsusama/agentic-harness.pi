# Compaction Workflow

Compacts when compacting pays, rather than when the window runs out,
and resumes the run it interrupted.

## Why

pi compacts when the context is nearly the size of the model's window.
On a 1M model a long run reads close to a million tokens on every turn
before anything is dropped: in the last month, turns over 200k tokens
were 95 percent of opus spend. The window stays the ceiling, because
some work genuinely needs it, and pi's own trigger still fires there.
Below it, this decides on cost.

## The Decision

After every turn, `compactionPays` in `lib/compaction/` weighs:

- **saved**: what the droppable context, everything past the prompt a
  compaction would retain, would cost to read on each of the turns
  still to come, estimated as the turns since the last compaction;
- **cost**: pi's summariser reading the whole context at full input
  price, plus the retained prompt being written fresh to the cache.

It never fires below 250k tokens. The retained prompt starts as the
session's first measured prompt (the fixed system prompt, tools and
instructions) plus pi's 20k of kept messages and room for the summary,
and after one of its own compactions it uses what that compaction
actually retained.

Replayed over a month of real sessions, with a simulator that
reproduces the actual bill within five percent, this cost 38.7 percent
less than compacting at the window: better than any fixed threshold,
with fewer compactions than the best of them. The replay assumes each
turn adds the same new content whatever the context size, which a
replay cannot prove, so the ledger's cost per turn and regret once this
is live are the real check. The replay lives with the spend quest as
`tools/threshold-replay.py`.

## Interrupt, Trigger, Resume

pi's `compact()` aborts the run in progress and does not continue it.
When the turn that tripped the decision made tool calls, so the run was
going to carry on, a message resumes it once the compaction lands,
unless a message of yours is already queued. Tested end to end in RPC
mode: a run compacted between tool turns resumed and finished its task.

Only interactive and RPC sessions are touched. A subagent runs pi in
`--mode json` and ends when its run does.

## Settings

- `PI_COMPACTION_POLICY=off` turns it off.
- `PI_COMPACTION_FLOOR_TOKENS` moves the 250k floor.

## Files

- `index.ts`: registration and the `turn_end` decision.

The decision is pure and tested in `lib/compaction/trigger.ts`; cache
prices under the retention in force come from
`lib/internal/cache-prices.ts`, shared with `demote-workflow`.
