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

## Summary Providers

This extension is the only handler of pi's `session_before_compact`,
but it does not write summaries itself. It asks a chain of providers
(`host.ts`), each implementing the contract in
`lib/compaction/provider.ts`:

- `assess(request)` says, synchronously and for free, whether it can
  write this summary and what that would cost;
- `write(request, signal)` writes it, answering a failure rather than
  rejecting.

On the spot, the first provider whose assessment passes writes, and a
failure passes the compaction to the next. Ahead, the first that
passes writes, and a failure leaves the compaction to the walk on the
spot. The host keeps everything around the summary: the clock on each
write, the verbatim tail, the file lists, what other extensions
contribute, and the record. The compaction entry's details name the
provider that wrote it (`summariser`), anything it wanted kept
(`provider`), and every provider that declined or failed before it
(`attempts`). When none writes, pi's own summariser runs as it would
with no extension, and a `compaction-summary-fallback` entry records
the attempts.

A failure the provider marks `retryable` (a dropped stream, an
overloaded or rate-limited provider, a server error) is asked once
more, two seconds later, before the compaction moves on. The first try
is recorded in `attempts` as `retried`. In one week before this, 14
summaries written ahead were lost to "Anthropic stream ended before
message_stop" alone, and each fell to a compaction on the spot that
kept somebody waiting up to a minute; the provider next down is slower
and dearer than a second try.

Two ship here. `conversation` (precedence 100) writes from the cached
conversation, below. `pi` (precedence 1000) calls pi's own summariser,
on the spot only, since it needs pi's preparation of the compaction.
It differs from letting pi compact in that contributions are kept and
the attempt is recorded. Another extension adds a provider by calling
`registerCompactionProvider(pi.events, provider)` from
`agentic-harness.pi/compaction`, whichever loads first; registering an
id again replaces it.

A focus typed with `/compact` skips a provider that cannot follow one
(`followsFocus: false`), and discards a summary written ahead without
it. A contributed focus skips nobody, and a summary from a provider
that did not follow it records `focusFollowed: false`.

The trigger prices the summary with the first provider that would
write it, ahead where one can: a summary from the cache and one from
pi's uncached summariser differ several times over, so a session that
cannot use its cache compacts later.

## The Conversation Provider

pi writes a summary by serialising the conversation to text, cutting
every tool result to 2,000 characters, and sending it to the model
with no cache. A turn that is split by the cut point takes a second,
sequential call. So pi pays full input price for a copy of the context
that the session's cache already holds, and the model only sees a
clipped copy.

`conversation.ts` writes it from the cached conversation instead. It
keeps the last request the session sent to the provider, byte for
byte, and sends that request again with the reply that came back, any
tool results since, and one closing instruction added. The closing
instruction reuses pi's checkpoint format word for word, so everything
downstream reads an ordinary summary, and it tells the model to stop
work and call no tool. The prefix is then read from cache, the model
sees every token of the conversation, and it takes one call. The added
messages carry no cache breakpoint, since nothing after the compaction
starts with them.

The kept request survives a `/reload` in the process, and a restart of
pi on disk (`kept-request.ts`): a shutdown that is not a reload writes
it, gzipped and readable only by its owner, under
`$XDG_STATE_HOME/pi/agentic-harness.pi/compaction-workflow/requests/`,
and the next start of the same session takes it back once. A file older
than an hour, which no cache could still answer for, is swept when a
session starts. `PI_COMPACTION_KEEP_REQUEST=off` keeps nothing on disk.

It leaves the summary room. A model that accepts a request whose output
allowance runs past its window stops writing when it reaches the window,
so a summary of a conversation near the window would come back cut off.
When the model says how large its window is, the output allowance is
capped at what the window leaves beside the conversation, less 4k for
the closing instruction, and the provider declines when that is under
twice what a summary usually takes (16k at least, never more than the
summary cap).

It declines or fails, with the reason, when it cannot do this
cleanly: no request has been sent yet this session, the model is not on
the Anthropic messages API or changed since, there are no credentials,
the cache may have expired, the last request overflowed the window, too
little of the window is left to write the summary, the conversation
moved on in a way the kept request cannot be extended to, or the reply
called a tool, hit the token cap, came back empty or failed.

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
  against pi's $115 over all 88, about $0.35 against $1.31 a
  compaction. The replay below wrote a median 7.7k tokens of output
  rather than pi's 13k, so the real difference should be larger. That
  7.7k counts thinking: the summary text itself is about 3.6k.
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

It prices a summary as it writes one: a cache read of the context
plus the output.

## Contributions

Another extension can add to whichever summary is written through
`SUMMARY_CONTRIBUTIONS` on `pi.events`, from `lib/compaction/`: it
pushes a focus instruction or text to append onto the request emitted
before each attempt, and reads `handled` afterwards to learn whether it
needs a summariser of its own for that compaction. A summary written
ahead asks once when it starts, for the focus, and again when the
compaction applies it, for the appendix and `handled`.

The request emitted when a compaction applies names
`firstKeptEntryId`, where its verbatim tail starts. With a summary
written ahead that can be earlier than pi's own cut, and anything a
contributor quotes from after it is in the context already. A
contributor says what it did through `recordContribution(request, id,
record)`, and the host keeps every record on the compaction entry as
`details.contributions`, so one that added nothing can say why.

Two use it here.
[`compaction-selection-provider`](../compaction-selection-provider/README.md)
starts its still-applies check alongside a summary written ahead, then
appends the paragraphs whose exact words matter, and records what it
found. [`session-recall-workflow`](../session-recall-workflow/README.md)
appends a note saying the dropped conversation can still be searched.
On a replayed exam of 133 questions about the dropped conversation,
the summary with 3k tokens of excerpts scored 0.718 against 0.549 for
the summary alone; recall was called on 27 of the questions and scored
0.26 higher on those.

## Outcomes

Every compaction's outcome is said on `pi.events` as
`COMPACTION_OUTCOME` (`compaction:outcome:v1`), as well as written to
the session:

- `compacted`, once pi has applied a compaction, with its
  `details`; `details.summariser` is absent when pi's own summariser
  wrote it;
- `fallback`, when no provider wrote it, with the reason and the
  attempts;
- `ahead-unused`, when a summary written ahead could not be used;
- `failed`, when the compaction itself failed.

A host that runs headless shows no notice, and one that rebuilds
sessions from a log of its own may drop the custom entries the
workflow writes, so the event is how such a host tells the harness
compacting apart from pi's summariser compacting, and why.

## Status

`/compaction-status` shows how compaction stands now, before the next
compaction rather than after it. It asks on `pi.events` as
`COMPACTION_STATUS` (`compaction:status:v1`), and each extension that
takes part adds a section of its own, so a section missing means that
extension is not loaded. The workflow's section says:

- whether the trigger is on, and any floor;
- the provider chain in the order it would be asked, and any
  configured id nothing registered;
- the cache retention the prices assume;
- whether a summary is being written ahead;
- the last outcome said on the bus since this code loaded;
- how many compactions the branch carries, and who wrote the last one
  and which contributions it recorded.

The selection adds its classifier, budget and tags, and how many
compactions quoted excerpts; recall adds whether its tool is active,
how many summaries mention it and how often it was called. Another
extension answers with `answerCompactionStatus` from
`lib/compaction/status.ts`.

## Running Under Another Host

The workflow is written to survive a host that runs pi as a library
and keeps sessions its own way:

- The verbatim tail never starts on a custom entry. pi's cut can name
  one, since it steps back over metadata to keep it with the message
  it precedes; a host that drops custom entries cannot resolve that
  boundary and the compaction fails. Starting at the next entry keeps
  exactly the same conversation, since a custom entry sends nothing.
- Outcomes are events as well as entries, above.
- The kept request survives a restart, so a host that starts a fresh
  process for each turn still summarises from cache.
- The selection can keep its tags in the process
  (`PI_COMPACTION_SELECTION_STORE=memory`), and knows a paragraph by
  its words, so tags survive a rebuild that changes every id.

## Settings

- `PI_COMPACTION_POLICY=off` turns it off.
- `PI_COMPACTION_FLOOR_TOKENS` sets a size it never compacts at or
  below; there is none by default.
- `PI_COMPACTION_PROVIDERS` names the chain, as comma-separated
  provider ids asked in that order; an id nothing registered is
  recorded in `attempts`. Unset, every registered provider is asked,
  lowest precedence first.
- `PI_COMPACTION_SUMMARY=pi` is shorthand for a chain of `pi` alone,
  which also means nothing is written ahead.
- `PI_CACHE_RETENTION=long` is what compacting while idle runs under.
- `PI_COMPACTION_KEEP_REQUEST=off` keeps no request on disk across a
  restart.

## Files

- `index.ts`: registration, the `turn_end` decision and the idle
  compaction.
- `idle.ts`: the timer that waits out an idle session.
- `notice.ts`: what the user is told when a compaction fires or fails.
- `status.ts`: the workflow's status section and `/compaction-status`.
- `host.ts`: the provider chain, writing ahead, and the one answer to
  a compaction.
- `conversation.ts`: the `conversation` provider, the summary written
  from the cached conversation.
- `kept-request.ts`: the last request, kept on disk across a restart.
- `pi-summary.ts`: the `pi` provider, pi's own summariser.

The decision is pure and tested in `lib/compaction/trigger.ts`, the
prices it reads from the session in `lib/compaction/history.ts`, where
a summary written ahead keeps from in `lib/compaction/prepared.ts`, the
outcome event in `lib/compaction/outcome.ts`, the
provider contract in `lib/compaction/provider.ts` and the chain's order
in `lib/compaction/chain.ts`, the
back-off in `lib/compaction/failure.ts`, and the summary's instruction,
splice and reading in `lib/compaction/summary.ts`; cache prices under
the retention in force come from `lib/internal/cache-prices.ts`.
