# Core's Work

The working layer: branches, commits, trees and stacks. Reviewing
a change is `lib/core/review`'s job; working on one is this
module's. It is not called git because git is one way to do it,
and on a stacked workflow the backend that tracks the stack knows
what git can't be asked. The files at the top hold the broker that
hands out trees and takes them back, choosing the provider that
cuts one, and the commits, rebases and stacks worked on in them.
`index.ts` is the whole surface.

## Folders

- `providers/`: the providers this package ships to cut trees.
  `git.ts` is the general case, a git worktree of a checkout on
  disk, so the broker works before anything else registers; a
  downstream provider that knows a repo is more specific and wins.
