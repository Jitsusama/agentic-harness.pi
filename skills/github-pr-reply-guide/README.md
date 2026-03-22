# GitHub PR Reply Guide

Methodology for responding to GitHub PR review feedback.

**Loaded by pi** when you're addressing review comments or
when the pr-reply workflow is active.

See `SKILL.md` for the full workflow documentation.

### Key Concepts

- **Thread-by-thread review**: iterate through all review
  comments systematically.
- **LLM analysis**: understand reviewer intent and get
  recommendations.
- **Flexible responses**: implement fixes (with or without
  TDD), post replies or defer.
- **Automatic commit linking**: commits are linked to threads,
  with SHAs in replies.
- **Stack awareness**: rebase dependent PRs after making
  changes.

### Related Skills

- `code-tdd-guide`: coordinates with PR reply for test-driven
  implementations.
- `commit-format`: commit message conventions for
  review-driven changes.
- `git-rebase-convention`: handles conflicts when rebasing
  stacks.
- `github-pr-format`: writing good PR descriptions.

### Related Extensions

- `extensions/pr-reply-workflow/`: the workflow
  implementation.
- `extensions/tdd-workflow/`: coordinates via events for
  test-driven fixes.
- `extensions/plan-workflow/`: shares plan directory
  configuration.
