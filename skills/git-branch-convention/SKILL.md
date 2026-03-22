---
name: git-branch-convention
description: >
  Branch naming, creation and safe transitions. Use when creating
  branches, switching between them or moving commits.
---

# Branch Management

## Naming

- Format: `username/short-description`
- Keep total length under 40 characters
- Lowercase, hyphens between words
- Be specific: `joel/oauth-refresh` not `joel/fix`

Get the username prefix via
`gh api user --jq .login | tr '[:upper:]' '[:lower:]'`.
Do not infer from existing branches or ask; always use
the authenticated GitHub user.

## Name Conflicts

When a branch name already exists, add specificity instead of
appending numbers:

- `oauth` taken → `oauth-refresh` (narrow the scope)
- `fix-leak` taken → `parser-memory-leak` (add the component)
- `api-fix` taken → `api-auth-fix` (add the area)

If the existing branch is doing the same work, ask whether
to use it instead of creating a new one.

## Before Creating

Assess the situation first:

- Is the working directory clean? Stash if dirty.
- Are there unpushed commits? They may need to move.
- What's the right base: main, a release branch, another
  feature branch?
- Is the current branch in a detached HEAD state?

## Safe Transitions

When moving work to a new branch:

1. Create the new branch from the current HEAD.
2. Push the new branch.
3. Return to the original branch.
4. Reset the original to its remote tracking branch.
5. Switch back to the new branch.

If stashed changes conflict when restoring, don't force it;
flag the conflict for manual resolution.

## What Not to Do

- Don't create branches from stale bases without pulling first.
- Don't leave the user on a detached HEAD.
- Don't lose commits; always verify after moving work.
- Don't force-push without discussion.
