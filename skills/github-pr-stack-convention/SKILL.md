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

After merging each PR:

1. **Wait for GitHub to retarget.** When a base branch
   is deleted after merge, GitHub automatically
   retargets any PR that had it as a base to the merged
   PR's own base (usually `main`). This is the safest
   path.
2. **If the base branch wasn't deleted**, retarget the
   next PR in the stack manually before merging it:
   ```bash
   gh pr edit NEXT_NUMBER --base main
   ```
3. **Wait for mergeability status** to update before
   merging the next PR. GitHub needs a moment to
   recompute:
   ```bash
   gh pr view NEXT_NUMBER \
     --json mergeable,mergeStateStatus \
     --jq '"\(.mergeable) | \(.mergeStateStatus)"'
   ```
   Don't merge until the status shows `MERGEABLE`
   and `CLEAN`.

## Branch Deletion and Auto-Close

Deleting a branch that another open PR uses as its base
will **auto-close** that dependent PR, and GitHub won't
let you reopen it. This is the single most dangerous
operation in a stack.

**Before deleting any branch**, check whether open PRs
depend on it:

```bash
gh pr list --state open --json baseRefName,number \
  --jq '.[] | select(.baseRefName == "BRANCH_TO_DELETE")'
```

If anything depends on it, retarget the dependent first:

```bash
gh pr edit DEPENDENT_NUMBER --base main
# Wait for status update, then delete the branch.
```

The `--delete-branch` flag on `gh pr merge` is safe for
the **top** of a stack (nothing depends on it) but
dangerous for any other position. Prefer merging
without `--delete-branch` and cleaning up branches
after the full stack is merged.

## Cleaning Up After a Full Merge

Once every PR in the stack is merged, follow the
post-merge local hygiene steps from
`github-pr-merge-convention`, batching all the stale
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
- Don't delete a base branch before retargeting its
  dependents.
- Don't use `--delete-branch` on anything except the
  top of the stack.
- Don't assume PR bases are correct. Verify the chain
  before merging.
- Don't rebase a branch in the middle of a stack
  without rebasing everything above it.
- Don't merge the next PR before confirming it shows
  `MERGEABLE | CLEAN`.
