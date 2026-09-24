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

It fires once saved reaches √2 times the cost, and never below 250k
tokens. The retained prompt starts as the
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

## Why √2

The replay put the cheapest margin at one, firing as soon as the saving
crosses the cost, but found cost nearly flat around it. Over the month
from 2026-08-24:

| Margin | Compactions | Mean prompt | Cost |
|---|---|---|---|
| 1 | 533 | 197k | $9,306 |
| √2 | 492 | 203k | $9,376 |
| 2 | 456 | 210k | $9,431 |

A compaction interrupts the run and loses detail the replay cannot
price, so the margin is √2: 8 percent fewer compactions for about $70 a
month. Raising the floor instead does the same job at a worse rate: a
300k floor gives 411 compactions for $231 more.

## Recorded Exploration

A live policy that always fires at √2 cannot be checked against
anything, since estimating another threshold from logged sessions needs
some sessions to have used it. So a fifth of stretches (a stretch runs
from one compaction to the next) draw a threshold of 1, firing a little
earlier, or 2, a little later, at equal chances. The earlier arm is
the replay's cheapest margin, so the one in use is measured against it.

A fifth because a smaller share would take too long: about 156 stretches
a month pass the floor, so five percent would log thirty a side in
about seven months, and a fifth does it in about two. By replay it costs
about nothing, since the arms either side of √2 cost $70 a month less
and $55 more if every stretch took them. Whether that flatness holds on
live sessions is what the draws measure. Stretches logged before
2026-09-24 used a margin of one with arms at 1/√2 and √2; the recorded
thresholds tell the two policies apart.

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

That message is sent as a user message, the way you would type it. pi
starts a run from a custom message without running the
`before_agent_start` hooks, so a resume sent that way went out on the
base system prompt, without the captured conventions or the loaded
quest that extensions add. Your next message put them back, and
because the system prompt sits right after the tool definitions, that
rewrote the whole context at the cache-write price once per compaction.
Measured on pi 0.87.1: the resumed request's system prompt was 4,813
characters shorter, every captured rule missing.

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

## Writing the Summary

pi writes a summary by serialising the conversation to text, cutting
every tool result to 2,000 characters, and sending it to the model
with no cache. A turn that is split by the cut point takes a second,
sequential call. So pi pays full input price for a copy of the context
that the session's cache already holds, and the model only sees a
clipped copy.

`summariser.ts` writes it from the cached conversation instead. It
keeps the last request the session sent to the provider, byte for
byte, and on `session_before_compact` it sends that request again
with the reply that came back, any tool results since, and one closing
instruction added. The closing instruction reuses pi's checkpoint
format word for word, so everything downstream reads an ordinary
summary, and it tells the model to stop work and call no tool. The
prefix is then read from cache, the model sees every token of the
conversation, and it takes one call. The added messages carry no
cache breakpoint, since nothing after the compaction starts with them.

It hands back to pi's summariser, and writes a
`compaction-summary-fallback` entry saying why, when it cannot do this
cleanly: no request has been sent yet this session (a `/reload` keeps
the last one, a restart does not), the model is not on
the Anthropic messages API or changed since, there are no credentials,
the cache may have expired, the last request overflowed the window, the
conversation moved on in a way the kept request cannot be extended to,
or the reply called a tool, hit the token cap, came back empty or
failed.

Measured on pi 0.87.1:

- **Live, about 100k tokens:** 102,506 of 102,514 prompt tokens read
  from cache, 17 seconds against pi's 23. Compacting mid-run, with
  tool results still unsent, read 90,217 from cache and sent the 7,232
  new tokens at full price. At this size it costs a few cents more
  than pi, which reads a clipped copy of a small context.
- **At real sizes:** the 88 compactions pi ran from 2026-09-17 had a
  median context of 315k tokens, of which pi sent 146k after clipping,
  and wrote a median 12k tokens of output. Priced at Opus 5.5 list, a
  full cache read of each context plus pi's own output comes to $31
  against pi's $115; the replay below wrote a median 7.7k tokens
  rather than pi's 13k, so the real difference should be larger.
- **Quality:** ten of those compactions, sampled at random, were
  replayed through this summariser and judged against the summary pi
  wrote at the time, blind and in random order. The judge read the
  whole conversation, knew which messages stay verbatim after either
  summary, and saw what the session did next. Opus 5.5 preferred this
  summary in all ten. Gemini 3.1 Pro, a different model family,
  preferred it in seven. All three it did not came down to one
  thing: the summary also covers what happens in the messages kept
  after it, so it reads as ahead of them. That is deliberate, since it
  describes the state at the end of the conversation while pi's
  describes the state at the cut and can carry next steps the kept
  messages have already done, which both judges flagged as misleading.
  But the order was unsaid, so every summary now opens with a fixed
  line saying it covers the messages that follow it. The replay cost
  $28.

The cost the trigger weighs (see The Decision) still assumes pi's
summariser, so when this one writes the summary, compacting costs
less than the trigger thinks and it fires somewhat later than it
would with the true price. That errs toward keeping context.

Another extension can add to the summary this writes through
`SUMMARY_CONTRIBUTIONS` on `pi.events`, from `lib/compaction/`: it
pushes a focus instruction or text to append onto the request emitted
before each attempt, and reads `handled` afterwards to learn whether it
needs a summariser of its own for that compaction.

## Settings

- `PI_COMPACTION_POLICY=off` turns it off.
- `PI_COMPACTION_FLOOR_TOKENS` moves the 250k floor.
- `PI_COMPACTION_EXPLORATION_RATE` sets the share of stretches that
  explore, 0.2 by default; `0` turns exploration off.
- `PI_COMPACTION_SUMMARY=pi` leaves every summary to pi's summariser.

## Files

- `index.ts`: registration and the `turn_end` decision.
- `notice.ts`: what the user is told when a compaction fires or fails.
- `summariser.ts`: the summary written from the cached conversation.

The decision is pure and tested in `lib/compaction/trigger.ts`, the
draw in `lib/compaction/threshold.ts` and the back-off in
`lib/compaction/failure.ts`, the summary's instruction, splice and
reading in `lib/compaction/summary.ts`; cache
prices under the retention in force come from
`lib/internal/cache-prices.ts`, shared with `demote-workflow`.
