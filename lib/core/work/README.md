# Core's Work

The working layer: branches, commits, trees and stacks. Reviewing
a change is `lib/core/review`'s job; working on one is this
module's. It is not called git because git is one way to do it,
and on a stacked workflow the backend that tracks the stack knows
what git can't be asked. The files at the top hold the broker that
hands out trees and takes them back, choosing the provider that
cuts one, and the commits, rebases and stacks worked on in them.
`index.ts` is the whole surface.

Many entries because each is one verb or one sweep over the single
tree record the broker keeps, and each changes for its own reason;
the eight sweep files, which share the most, are the first to go to
a folder of their own.

## Hosted Holders

Tree memory records the calling conversation's session owner in a host,
not just its pid. B sees A as another holder even when both run in one
process, and releasing A removes only A's claim. Liveness checks consult
the host's open-conversation list after confirming its process identity,
using kernel ticks where available so suspend cannot retire a live hold.
Plain pi retains its existing process holders.

A session outlives its process, so `reownSession` names the process a
session runs in now on every record with an owner naming the session.
It drops the session's earlier entry and any holder whose process has
gone, and keeps every other holder. A tree that lists the session only
as the runner of the subagent that cut it is left to that subagent.

## The Work Section

The package config's `work` section keys two things by a checkout's
common git folder, taken by its real path with no trailing slash
(`byGitFolder` in `fetch-rule-config.ts`):

- `fetches`: how its fetches are made, from a prefetch or behind a
  command taking the fetch's turn (`fetch-rules.ts`).
- `pushChecks`: a check run in the tree before each push, as
  `{"run": "<shell text>", "seconds": 300}`, `seconds` optional
  (300, at most 900) (`push-checks.ts`). `publish.ts` runs it unless
  the remote's ref already holds what is pushed, and a check that
  fails or runs past its time refuses the push, naming the check,
  how it ended, how to rerun it and its last 40 lines.

An entry written wrong is left out, and that checkout fetches and
pushes as it always did. `extensions/work-integration/README.md`
says why each exists and shows the section written out.

## Folders

- `providers/`: the providers this package ships to cut trees.
  `git.ts` is the general case, a git worktree of a checkout on
  disk, so the broker works before anything else registers; a
  downstream provider that knows a repo is more specific and wins.
