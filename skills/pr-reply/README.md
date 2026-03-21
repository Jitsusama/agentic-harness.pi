## PR Reply Skill

Methodology for responding to GitHub PR review feedback.

**Loaded by pi** when you're addressing review comments or when
pr-reply mode is active.

See `SKILL.md` for the full workflow documentation.

### Key Concepts

- **Thread-by-thread review**: iterate through all review comments systematically.
- **LLM analysis**: understand reviewer intent and get recommendations.
- **Flexible responses**: implement fixes (with/without TDD), post replies or defer.
- **Automatic commit linking**: commits are linked to threads, SHAs in replies.
- **Stack awareness**: rebase dependent PRs after making changes.

### Related Skills

- `tdd-workflow`: coordinates with pr-reply for test-driven implementations.
- `git-commit-format`: commit message conventions for review-driven changes.
- `git-rebase-resolution`: handles conflicts when rebasing stacks.
- `pr-writing`: writing good PR descriptions.

### Related Extensions

- `extensions/pr-reply/`: the mode implementation.
- `extensions/tdd-mode/`: coordinates via events for test-driven fixes.
- `extensions/plan-mode/`: shares plan directory configuration.
