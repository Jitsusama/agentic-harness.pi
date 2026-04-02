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

### With Auto-Delete (Preferred)

If the repository has the "Automatically delete head
branches" setting enabled (`delete_branch_on_merge:
true`), merge each PR without `--delete-branch`:

```bash
gh pr merge NUMBER --merge
```

GitHub handles branch deletion as part of its internal
merge flow, which triggers auto-retarget: any open PR
that had the deleted branch as its base gets retargeted
to the merged PR's target (usually `main`). This is the
safest and simplest path through a stack.

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

To check whether the setting is enabled:

```bash
gh api repos/OWNER/REPO --jq .delete_branch_on_merge
```

To enable it (requires admin access):

```bash
gh api repos/OWNER/REPO -X PATCH \
  -f delete_branch_on_merge=true
```

### Without Auto-Delete (Fallback)

If the repository does not have auto-delete enabled and
you can't change the setting, use a three-step flow for
each PR in the stack:

1. Merge without `--delete-branch`:
   ```bash
   gh pr merge NUMBER --merge
   ```
2. Retarget the next PR in the stack:
   ```bash
   gh pr edit NEXT_NUMBER --base main
   ```
3. Delete the branch after the retarget is confirmed:
   ```bash
   git push origin --delete BRANCH_NAME
   ```

After step 3, verify the next PR is in good shape before
continuing:

```bash
gh pr view NEXT_NUMBER \
  --json baseRefName,mergeable,mergeStateStatus \
  --jq '"\(.baseRefName) | \(.mergeable) | \(.mergeStateStatus)"'
```

Repeat for each PR in the stack, bottom to top.

## Why `--delete-branch` Is Broken for Stacks

Do not use `gh pr merge --delete-branch` when merging
stacked PRs. The CLI's `--delete-branch` flag deletes
the branch via a separate API call after the merge
completes. GitHub treats this the same as `git push
origin --delete`: a raw branch deletion that
**auto-closes** every open PR that uses the deleted
branch as its base. Those PRs can't be reopened; they
must be recreated from scratch.

The auto-retarget behaviour that makes stack merging
smooth only happens when GitHub's own internal flow
deletes the branch (the web UI merge button or the
`delete_branch_on_merge` repo setting). No external
API call can trigger it. This is
[cli/cli#1168](https://github.com/cli/cli/issues/1168),
open since 2020.

For standalone PRs (no dependents), `--delete-branch`
is still fine. The danger is specific to PRs whose
branch is another PR's base.

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

- Don't use `--delete-branch` with `gh pr merge` when
  the PR has dependents. It auto-closes them
  permanently. See "Why `--delete-branch` Is Broken
  for Stacks" above.
- Don't merge out of order. Always bottom-up.
- Don't delete a branch without retargeting dependents
  first (unless the repo's auto-delete setting handles
  retarget for you).
- Don't assume PR bases are correct. Verify the chain
  before merging.
- Don't rebase a branch in the middle of a stack
  without rebasing everything above it.
- Don't merge the next PR before confirming it shows
  `MERGEABLE | CLEAN`.
