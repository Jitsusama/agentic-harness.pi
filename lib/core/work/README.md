# Core's Work

The working layer: branches, commits, trees and stacks. Reviewing
a change is `lib/core/review`'s job; working on one is this
module's. It is not called git because git is one way to do it,
and on a stacked workflow the backend that tracks the stack knows
what git can't be asked. The files at the top hold the broker that
hands out trees and takes them back, choosing the provider that
cuts one, and the commits, rebases and stacks worked on in them.
`index.ts` is the whole surface.

## Hosted Holders

Tree memory records the calling conversation's session owner in a host,
not just its pid. B sees A as another holder even when both run in one
process, and releasing A removes only A's claim. Liveness checks consult
the host's open-conversation list after confirming its process identity,
using kernel ticks where available so suspend cannot retire a live hold.
Plain pi retains its existing process holders.

## Folders

- `providers/`: the providers this package ships to cut trees.
  `git.ts` is the general case, a git worktree of a checkout on
  disk, so the broker works before anything else registers; a
  downstream provider that knows a repo is more specific and wins.
