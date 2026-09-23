# Demote Workflow

Demotes old bash results out of the prompt in batches, only when a
batch pays for the cache rewrite it causes, and gives the model
`expand_demoted` to recover any of them by digest.

## One Policy, Two Modes

By default this runs in shadow. Every turn it decides what it would
demote and keeps the set it would have frozen, but the prompt goes out
exactly as pi assembled it. With `PI_DEMOTE_BASH_RESULTS=1` it acts on
the same decisions. `/demote-status` reports batches fired, results
demoted, characters taken off every later prompt and how often a
demoted result was recovered, in either mode.

## Why Batches

The provider's prompt cache is a prefix cache: changing one message
re-writes everything after it at the cache-write price, twenty times a
read under one-hour retention. The first version of this extension
demoted each bash result the moment it left a recent window, which
re-writes a suffix on every turn. Replayed over a month of real
sessions, that policy would have cost about $10,200 a month more than
doing nothing.

So a batch, every bash result outside the 30 most recent tool results
that is not demoted yet, fires only when compaction's own payback test
says so: the reads it saves on the turns still to come outweigh
re-writing the suffix after its first result once. The turns still to
come are estimated as the turns so far. Between batches the demoted set
is frozen and re-applied as the same stubs, so the prompt stays
byte-identical and the cache holds. Demotion is compaction that keeps
its bytes.

The same replay puts the batched policy at about $300 a month net, and
about $550 with a 10-result window. The wider window is kept because
nothing yet measures what a tighter one costs in quality. The replay
lives with the spend quest as `tools/demote-replay.py`.

## Nothing Is Deleted

The stored session keeps every result; pi's `context` event only shapes
what one request sends. The full text of each demotion is kept in a
bounded, session-scoped cache keyed by the digest its stub names, and
`expand_demoted` returns it through the same bounded-answer mechanism
every other large answer in this package uses. Every recovery is
counted: recoveries over demotions is the direct measure of how often
a demotion was wrong.

## Files

- `index.ts`: registration, the `context` hook, `/demote-status` and
  `expand_demoted`.
- `size.ts`: characters each of pi's message kinds puts in the prompt.
- `prices.ts`: read and write prices under the retention in force.
- `bounded.ts`: bounding a recovered result.

The batch decision, stubs, cache and counting are pure and tested in
`lib/demote/`.
