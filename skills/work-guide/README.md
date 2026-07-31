# Work Guide

How to get somewhere to work and move the work along through
the `work` tool: cutting a worktree or pinning a snapshot,
branching, committing, publishing, replaying onto a new base,
and keeping a stack of branches each sitting on the one below
it.

Covers what a snapshot is for and what a worktree is for, why
a tree is read before it is repointed, the boundary that stops
a restack handing every branch its parent's commits, how a
halted replay is settled, and the one seam where the working
layer cannot see what the review layer knows.

Pairs with [`review-guide`](../review-guide/) for putting the
work up once it is worth showing somebody,
[`git-branch-convention`](../git-branch-convention/) for
naming and [`commit-format`](../commit-format/) for the
message.

Backed by the `work-integration` extension over the `lib/work`
library.
