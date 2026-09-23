# Demote Workflow

Rewrites an already-resident bash result that `context-shadow-workflow`
found reclaimable into a short stub, and gives the model a tool,
`expand_demoted`, to ask for it back by digest.

## The Actuator, Not the Measurement

`context-shadow-workflow` only measures what could be reclaimed and
changes nothing. This extension is the other half: it actually
rewrites what is sent, for the same candidates that extension already
identifies, and is a genuinely separate, more consequential step.
Cutting a resident result is a quality trade, not provable waste, so
it stays behind `PI_DEMOTE_BASH_RESULTS=1`. Leaving it unset changes
nothing at all, same treatment as `output-ceiling-workflow` and for the
same reason: there is no sensor yet that would catch this trade going
wrong.

## Reversibility Is the Whole Point

The full text of every demotion is kept in a bounded, session-scoped
cache, keyed by the digest named in its stub. Asking for it back is
`expand_demoted(digest)`, and every answered request is counted as a
re-expansion.

Counting is scoped to distinct results, not to every call. A candidate
found on one `context` call is still a candidate on the next, since the
kept recent window only moves forward in a session, never back. Only
the first time a given digest is demoted counts toward the total: a
naive per-call count would inflate "demoted" far past the number of
results actually cut, and the re-expansion rate this exists to measure
would read as far smaller than it really is.

That rate, reexpanded over demoted, is the direct measure of pruner
error the wider plan calls for. A controller that is never asked back
for what it cut is not being cautious about it, it is doing nothing
worth counting. A controller that is asked back often is wrong about
its own cuts, whatever it thought it was saving.

## Files

- `index.ts`: registration, the `context` hook and the `expand_demoted`
  tool.

The stub, the cache and the counting are all pure and tested, in
`lib/demote/`.
