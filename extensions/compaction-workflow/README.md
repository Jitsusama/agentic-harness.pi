# Compaction Workflow

Compacts when compacting pays and not a turn sooner, writes the summary
in the background so nobody waits for it, and resumes the run it
interrupted.

## Why

pi compacts when the context is nearly the size of the model's window.
On a 1M model a long run reads close to a million tokens on every turn
before anything is dropped: in the last month, turns over 200k tokens
were 95 percent of opus spend. The window stays the ceiling, because
some work genuinely needs it, and pi's own trigger still fires there.
Below it, this decides on cost.

## The Decision

Context a compaction would drop costs rent: every turn reads it again
at the cache-read price. Compacting clears the rent for a fixed cost.
That is the reorder-quantity problem, and its cheapest rhythm is to
clear the rent once what it has cost since the last clearing reaches
what clearing costs. So after every turn `lib/compaction/trigger.ts`
adds that turn's rent (`droppableRent`: everything past what a
compaction keeps, at the read price) and `compactionPays` fires once
the total reaches `compactionCost`, which has three parts:

- **summary:** the summariser reading the context back from cache,
  plus its output, thinking included;
- **rewrite:** the first turn after a compaction writing what it kept
  to the cache, priced at the write price less the read it replaces;
- **re-fetching:** the turns spent fetching back what was dropped.

Each part is measured from the session's own log rather than assumed:
the output of its last summary, the cache write of the first turn
after its last compaction, and the mean cost of its recent turns beyond
their reads. Until the session has compacted once, defaults stand in,
each from measurement:

- **7,700 output tokens** for a summary: the median of ten real
  compactions replayed through the summariser below.
- **Everything kept, rewritten**: errs toward compacting later.
- **Three turns** of re-fetching. Over 97 compactions from 2026-09-17,
  re-fetched tool output cost a median $0.19 and a mean $0.35 a
  compaction under 400k, about three turns at that size, and a
  comparison cut that dropped nothing found 61 percent as much
  re-reading. Three is the gross figure, so this too errs toward later.
  It misses re-deriving something by another route and acting on a
  summary that went stale, so it is a lower bound on what dropping
  costs.
- **$0.045** a turn beyond its reads: at 100k to 200k tokens under
  one-hour retention a turn cost $0.076, of which reading was $0.031.

The cost is nearly flat around the optimum, so how well these inputs
are measured matters more than where exactly it fires. That is why an
earlier margin of √2 and a randomised experiment on it are gone: the
experiment's stake was about one percent of spend, and its answer would
have aged out with the next change to prices or to the summariser.

There is no floor by default. `PI_COMPACTION_FLOOR_TOKENS` sets a size
it never compacts at or below.

## Writing Ahead

A summary takes a minute or two at real sizes: output runs at about 80
tokens a second and a summary is several thousand. So when the trigger
fires, the summary is started in the background and work carries on.
At the end of the first turn after it is ready, or at once when the
session is idle, the compaction applies it, which takes no time.

Work carries on while it is written, so the summary covers the
conversation only up to the point it was started at. Everything after
that point stays verbatim (`lib/compaction/prepared.ts`): the kept
messages start at the earlier of pi's own cut and the entry after the
covered point, so nothing is dropped that the summary did not see. A
compaction asked for while a summary is being written waits for that
one rather than writing a second.

Only when the summary cannot be written from the cache (see Writing the
Summary) does the session compact on the spot, and the notice says
why. Each compaction's entry records `written` (`ahead` or `on the
spot`), how long the summary took (`summaryMs`) and how long anybody
waited for it (`waitedMs`). A summary written ahead that went unused is
logged as a `compaction-summary-ahead-unused` entry with the reason.

## Compacting While Idle

An idle session's cache expires after an hour, and the first turn back
then writes the whole context at the write price. Five minutes before
it expires, an idle session is compacted if the rewrite that avoids
(everything past what a compaction keeps, at the write price) is worth
more than the summary and the re-fetching (`idleCompactionPays`). The
rewrite of what it keeps is not counted: coming back pays it either way.
The summary reads the cache while it is still warm. A run starting
first calls it off.

Under one-hour retention only: at five minutes this would compact every
pause for coffee.

## Interrupt, Trigger, Resume

pi's `compact()` aborts the run in progress and does not continue it.
When the turn that tripped the decision made tool calls, so the run was
going to carry on, a message resumes it once the compaction lands,
unless a message of yours is already queued. Tested end to end in RPC
mode: a run compacted between tool turns resumed and finished its task.
A compaction applied while the session is idle interrupts nothing and
resumes nothing.

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
far above where this policy compacts. A summary written ahead is capped
against that same 64,000 reserve, since pi hands an extension its
settings only with a compaction.

## Writing the Summary

pi writes a summary by serialising the conversation to text, cutting
every tool result to 2,000 characters, and sending it to the model
with no cache. A turn that is split by the cut point takes a second,
sequential call. So pi pays full input price for a copy of the context
that the session's cache already holds, and the model only sees a
clipped copy.

`summariser.ts` writes it from the cached conversation instead. It
keeps the last request the session sent to the provider, byte for
byte, and sends that request again with the reply that came back, any
tool results since, and one closing instruction added. The closing
instruction reuses pi's checkpoint format word for word, so everything
downstream reads an ordinary summary, and it tells the model to stop
work and call no tool. The prefix is then read from cache, the model
sees every token of the conversation, and it takes one call. The added
messages carry no cache breakpoint, since nothing after the compaction
starts with them. The kept request survives a `/reload`.

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

The trigger prices a summary as this one writes it: a cache read of
the context plus the output. When pi's summariser runs instead, the
real cost is higher than the trigger thought, which is a fallback
rather than the rule.

Another extension can add to the summary this writes through
`SUMMARY_CONTRIBUTIONS` on `pi.events`, from `lib/compaction/`: it
pushes a focus instruction or text to append onto the request emitted
before each attempt, and reads `handled` afterwards to learn whether it
needs a summariser of its own for that compaction. A summary written
ahead asks once when it starts, for the focus, and again when the
compaction applies it, for the appendix and `handled`.

## Settings

- `PI_COMPACTION_POLICY=off` turns it off.
- `PI_COMPACTION_FLOOR_TOKENS` sets a size it never compacts at or
  below; there is none by default.
- `PI_COMPACTION_SUMMARY=pi` leaves every summary to pi's summariser,
  which also means nothing is written ahead.
- `PI_CACHE_RETENTION=long` is what compacting while idle runs under.

## Files

- `index.ts`: registration, the `turn_end` decision and the idle
  compaction.
- `idle.ts`: the timer that waits out an idle session.
- `notice.ts`: what the user is told when a compaction fires or fails.
- `summariser.ts`: the summary written from the cached conversation,
  ahead or on the spot.

The decision is pure and tested in `lib/compaction/trigger.ts`, the
prices it reads from the session in `lib/compaction/history.ts`, where
a summary written ahead keeps from in `lib/compaction/prepared.ts`, the
back-off in `lib/compaction/failure.ts`, and the summary's instruction,
splice and reading in `lib/compaction/summary.ts`; cache prices under
the retention in force come from `lib/internal/cache-prices.ts`.
