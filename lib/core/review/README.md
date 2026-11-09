# Core's Review

One substrate for reviewing code changes, whatever hosts them and
whether anything hosts them at all. A change, its stack, its
reviews, its threads and its messages are one neutral model, in
git's words wherever git has one, and each host is a provider
behind it. The files at the top hold that model, the provider
contract, choosing a provider for a reference, and the engine a
consumer talks to. `index.ts` is the whole surface.

## Folders

- `ask/`: asking models to review a change: the roster and its
  personas, a council asked at once, a judge to consolidate it and
  a critique to push back, rounds over a whole stack, and the
  rounds kept on disk so another session can take them up.
- `draft/`: a person's review as it is written: the remarks,
  replies, reactions and verdict it gathers, kept on disk between
  sessions, compiled into a plan of what each provider will
  accept, and published, across a stack too, or written down as a
  document where nothing can take it.
- `providers/`: the providers this package ships, one folder each:
  `git/` for a repo with no forge behind it and `github/` for
  GitHub. Their registry is in `lib/core/internal/review`.
