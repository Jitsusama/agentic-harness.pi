---
name: github-pr-stack-convention
description: >
  Stacked PR lifecycle: creating, retargeting, rebasing and
  merging PRs that depend on other PRs. Use when merging PRs,
  rebasing branches that have dependents, or creating PRs
  based on other PRs.
---

# Stacked PR Convention

A PR stack is a chain of pull requests where each one's
branch is based on the previous one's branch. They let
you break large changes into reviewable pieces while
keeping a linear dependency order. This skill covers
how to detect, create, retarget and merge stacked PRs
safely.

For merge strategy, branch deletion defaults and
post-merge local cleanup, see `github-pr-merge-convention`.
This skill adds the stack-specific constraints on top
of those defaults.

## Detecting a Stack

Before merging or rebasing any PR, check whether it's
part of a stack. A PR is in a stack if either condition
is true:

- Its base branch is another feature branch (not `main`
  or a release branch).
- Another open PR's base branch is this PR's head branch.

Check both directions:

```bash
# What is this PR's base?
gh pr view NUMBER --json baseRefName --jq .baseRefName

# Does anything depend on this PR's branch?
gh pr list --state open --json baseRefName,headRefName,number \
  --jq '.[] | select(.baseRefName == "BRANCH_NAME")'
```

If either check reveals a dependency, apply the rules
below. If neither does, it's a standalone PR and none
of this applies.

## Creating a Stacked PR

When creating a PR that depends on another PR's branch:

1. Base the new branch on the predecessor's branch, not
   on `main`.
2. **Verify the current branch** before creating the PR.
   `gh pr create` always uses the current checkout as
   the head branch, regardless of `--head`. Confirm
   with a separate bash call:
   ```bash
   git branch --show-current
   ```
3. Set the PR's base to the predecessor's branch:
   ```bash
   gh pr create --base predecessor-branch ...
   ```
4. After creation, verify the head is correct:
   ```bash
   gh pr view NUMBER --json headRefName --jq .headRefName
   ```
5. Update the parent PR's description with the `👉`
   link per `github-pr-format`.

## Verifying the Chain Before Merging

Before merging any PR in a stack, verify the entire
chain is wired correctly. Every PR's base should point
to the previous PR's head branch, with the bottom of
the stack pointing to `main`:

```bash
gh pr list --state open \
  --json number,baseRefName,headRefName \
  --jq 'sort_by(.number)[] |
    "#\(.number) base=\(.baseRefName) head=\(.headRefName)"'
```

If any PR in the stack has a wrong base (for example,
pointing to `main` when it should point to its
predecessor), fix the base before merging anything:

```bash
gh pr edit NUMBER --base correct-base-branch
```

Fix every miswired base in the chain first. Then start
merging.

## Merge Order

Always merge bottom-up: the PR closest to `main` first,
then the next one up, and so on. Never merge a PR in
the middle or top of a stack before its predecessors.

Use `--delete-branch` on every merge, same as a
standalone PR:

```bash
gh pr merge NUMBER --merge --delete-branch
```

When `--delete-branch` is part of the same `gh pr merge`
call, GitHub treats the branch deletion as part of the
merge event. It automatically retargets any open PR that
had the deleted branch as its base to the merged PR's
target (usually `main`). This is the safest and simplest
path through a stack.

After each merge, wait for GitHub to finish retargeting
and recompute mergeability before merging the next PR:

```bash
gh pr view NEXT_NUMBER \
  --json baseRefName,mergeable,mergeStateStatus \
  --jq '"\(.baseRefName) | \(.mergeable) | \(.mergeStateStatus)"'
```

Don't merge until the base shows `main` (or whatever the
stack's root target is), mergeable shows `MERGEABLE` and
status shows `CLEAN`.

## Branch Deletion Outside of Merge

The safe auto-retarget behaviour described above **only**
applies when `--delete-branch` runs as part of
`gh pr merge`. If a branch is deleted by any other means
(such as `git push origin --delete`, the GitHub UI or a
separate API call after the merge already completed),
GitHub will **auto-close** every open PR that uses the
deleted branch as its base. Those PRs cannot be
reopened; they must be recreated from scratch.

This distinction matters when a PR was already merged in
a prior step (or by someone else) and you're cleaning up
the branch later. In that case, retarget all dependents
before deleting:

```bash
# Check for dependents.
gh pr list --state open --json baseRefName,number \
  --jq '.[] | select(.baseRefName == "BRANCH_TO_DELETE")'

# Retarget each one.
gh pr edit DEPENDENT_NUMBER --base main

# Wait for status to update, then delete.
git push origin --delete BRANCH_TO_DELETE
```

## Post-Merge Local Hygiene

After the full stack is merged, follow the cleanup steps
from `github-pr-merge-convention`, batching all stale
branches together.

## Rebasing a Stack

When the bottom of a stack needs a rebase onto `main`,
rebase bottom-up: rebase the bottom branch first, then
rebase each subsequent branch onto the one below it.
Force-push each branch after rebasing.

Never rebase a branch in the middle of a stack without
rebasing everything above it. The branches above will
have stale merge bases and will conflict or silently
carry wrong code.

## What Not to Do

- Don't merge out of order. Always bottom-up.
- Don't delete a branch outside of `gh pr merge
  --delete-branch` without retargeting dependents
  first. A raw branch delete auto-closes dependent
  PRs permanently.
- Don't assume PR bases are correct. Verify the chain
  before merging.
- Don't rebase a branch in the middle of a stack
  without rebasing everything above it.
- Don't merge the next PR before confirming it shows
  `MERGEABLE | CLEAN`.
