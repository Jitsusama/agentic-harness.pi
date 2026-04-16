---
name: git-commit-convention
description: >
  Operational commit rules: when to commit, what goes in
  each commit, commit frequency and history management.
  Use when committing code, deciding commit boundaries or
  managing git history. Pairs with commit-format for message
  structure.
---

# Git Commit Convention

For the commit message format itself (conventional commits,
types, scopes, subject and body rules), see `commit-format`.
This skill covers the operational conventions: when to commit,
what goes in each commit, and how to manage history.

## Commit Frequency

- Commit after each logical unit of work.
- In TDD: commit after each green + refactor cycle.
- When planning: commit the plan file itself.
- Don't batch unrelated changes into one commit.

## Atomic Commits

Each commit should be one concern:

- One bug fix per commit.
- One feature step per commit.
- One refactor per commit.
- Tests and implementation in the same commit (they're one
  unit).

If you find yourself writing "and" in the subject line, it's
probably two commits.

## History

- Interactive rebase is fine for cleaning local history
  before push.
- Never force-push shared branches without discussion.
- Prefer `--force-with-lease` over `--force` when rewriting
  remote.
- **Never use `--amend`.** Make a new commit instead.
  Amending rewrites history and is almost never worth it.
  A new commit is cleaner and preserves the work trail.
  If the previous commit has a mistake, fix it forward
  with a new commit.
- Avoid WIP commits on shared branches; squash locally
  with interactive rebase before pushing.

## When Not to Commit

- Broken tests (unless explicitly spiking or experimenting).
- Half-finished features without a clear stopping point.
- Generated files that should be in .gitignore.
