# PR Review Extension

Structured workflow for reviewing someone else's pull request.
Gathers context from the PR, linked issues, and codebase, then
guides a review through description evaluation, deep analysis,
file-by-file comment collection, and posting.

## How It Works

The agent calls the `pr_review` tool with different actions to
drive the workflow:

1. **Activate** — parse PR reference, create worktree (if needed),
   gather context from GitHub (metadata, diff, linked issues,
   sibling PRs)
2. **Context** — show gathered context summary
3. **Description** — evaluate PR title, description, and scope
4. **Analyze** — deep analysis with codebase searching
5. **Review files** — file-by-file diff review with comment drafting
6. **Vet** — final comment review and verdict selection
7. **Post** — submit the review to GitHub
8. **Deactivate** — clean up worktree and exit

## Review Comments

All comments use [Conventional Comments](https://conventionalcomments.org/)
format with labels (praise, suggestion, issue, question, etc.),
decorations (blocking, non-blocking), and a teaching-oriented tone.

## Design Notes

**No `enforce.ts`**: Unlike TDD mode which blocks writes during
RED phase, pr-review mode has no tool enforcement. The review
workflow is inherently read-only — the reviewer reads diffs and
writes comments, but doesn't need protection against accidental
writes. The mode tracks workflow phase for UI display and context
injection, not for constraint enforcement.
