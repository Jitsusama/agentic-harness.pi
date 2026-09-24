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

## Recorded Exploration

Firing once the saving crosses the cost, a margin of one, was chosen by
replay. A live policy that always fires there cannot be checked against
anything, since estimating another threshold from logged sessions needs
some sessions to have used it. So a fifth of stretches (a stretch
runs from one compaction to the next) draw a threshold of 1/√2, firing
a little earlier, or √2, a little later, at equal chances.

A fifth because a smaller share would take too long: about 156 stretches
a month pass the floor, so five percent would log thirty a side in
about seven months, and a fifth does it in about two. The replay prices
it at about $12 a month, since it finds cost nearly flat around a
margin of one ($48 a month more if every stretch fired at 1/√2, $70 at
√2). Whether that flatness holds on live sessions is what the draws
measure.

The draw is made on the stretch's first turn above the floor, before
the decision it shapes, and written to the session log as a
`compaction-threshold` custom entry holding the threshold, the
probability it had and whether it was explored. Custom entries are not
sent to the model, so this costs no context. A resumed session reads
its draw back rather than drawing again, and the notice says when a
compaction came from an explored threshold.

## Interrupt, Trigger, Resume

pi's `compact()` aborts the run in progress and does not continue it.
When the turn that tripped the decision made tool calls, so the run was
going to carry on, a message resumes it once the compaction lands,
unless a message of yours is already queued. Tested end to end in RPC
mode: a run compacted between tool turns resumed and finished its task.

Only interactive and RPC sessions are touched. A subagent runs pi in
`--mode json` and ends when its run does.

## When a Compaction Fails

A failed compaction resumes the run it interrupted the same way, so the
work does not stop. Nothing is lost: the context is left as it was. The
trigger then holds off for 8 turns, doubling with each failure in a row
up to 128, and the failure is written to the session log as a
`compaction-failed` entry with the size, the error, the streak and the
wait. A cancelled compaction holds off too but is not resumed.

Before this, the trigger fired again on the very next turn. Since pi's
`compact()` aborts the turn in progress, a failure that repeated stopped
the work on every turn, and pi only ever showed it as a passing notice,
so no search of the logs could find one. In September 2026 that was a
summary cut off at pi's summary cap: four fifths of
`compaction.reserveTokens`, 13,107 tokens at the default 16,384. Each
summary rewrites the one before it, so it grows over a long session:
logged summaries ran 11k to 16k tokens of text, a 315k-token session
compacted with no cap billed 27,375 output tokens with its thinking,
and the proxy logged every failed attempt at exactly 13,107. The notice
for that failure names the fix:

```json
{ "compaction": { "reserveTokens": 64000 } }
```

in `~/.pi/agent/settings.json`, which allows a 51,200-token summary,
1.9 times the largest measured. The reserve also moves pi's own window
trigger earlier, to 936k on a 1M model and 436k on grok's 500k, both
far above where this policy compacts.

## Settings

- `PI_COMPACTION_POLICY=off` turns it off.
- `PI_COMPACTION_FLOOR_TOKENS` moves the 250k floor.
- `PI_COMPACTION_EXPLORATION_RATE` sets the share of stretches that
  explore, 0.2 by default; `0` turns exploration off.

## Files

- `index.ts`: registration and the `turn_end` decision.
- `notice.ts`: what the user is told when a compaction fires or fails.

The decision is pure and tested in `lib/compaction/trigger.ts`, the
draw in `lib/compaction/threshold.ts` and the back-off in
`lib/compaction/failure.ts`; cache
prices under the retention in force come from
`lib/internal/cache-prices.ts`, shared with `demote-workflow`.
