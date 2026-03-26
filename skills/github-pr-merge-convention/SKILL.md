---
name: github-pr-merge-convention
description: >
  PR merge strategy, branch cleanup and post-merge hygiene.
  Use when merging a PR, cleaning up after a merge or
  deciding how to land changes on the default branch.
---

# PR Merge Convention

This skill covers how to merge pull requests and clean
up afterwards. It applies to every PR, whether standalone
or part of a stack. For stack-specific ordering and
safety rules, see `github-pr-stack-convention`.

## Merge Strategy

Use a regular merge commit by default. This preserves
the branch's commit history on the target branch, which
matters: individual commits carry context (why a change
was made, what test drove it, what refactor followed).
Squashing throws that away.

```bash
gh pr merge NUMBER --merge
```

If a repository has its own merge strategy configured or
documented, follow that instead. The repo's convention
wins over this default.

## Branch Cleanup

Always delete the remote branch after merging to the
default branch. There is no reason to keep merged
branches around; they clutter the branch list and
create ambiguity about what's still in flight.

```bash
gh pr merge NUMBER --merge --delete-branch
```

The `--delete-branch` flag handles both the remote
branch and the local tracking branch in one step.

This is safe even when the PR is part of a stack.
When `--delete-branch` runs as part of `gh pr merge`,
GitHub auto-retargets dependent PRs rather than closing
them. See `github-pr-stack-convention` for the full
merge sequence.

## Post-Merge Local Hygiene

After the merge, clean up the local checkout:

1. Switch back to the default branch and pull:
   ```bash
   git switch main && git pull
   ```
2. Prune stale remote tracking refs:
   ```bash
   git fetch --prune
   ```
3. Delete the local branch if it still exists:
   ```bash
   git branch -d branch-name
   ```

If multiple branches were merged (after completing a
stack, for example), batch the cleanup:

```bash
git switch main && git pull
git fetch --prune
git branch -d branch-1 branch-2 branch-3
```

## What Not to Do

- Don't squash unless the repository explicitly requires
  it. History has value.
- Don't leave merged branches on the remote. Delete them.
- Don't skip the local cleanup. Stale local branches and
  tracking refs accumulate silently.
- Don't delete a branch outside of `gh pr merge
  --delete-branch` when other open PRs depend on it.
  A raw delete (via `git push --delete`, the GitHub UI
  or a separate API call) auto-closes dependents
  permanently. See `github-pr-stack-convention`.
