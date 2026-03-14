## PR Reply Skill

Methodology for responding to GitHub PR review feedback.

**Loaded by pi** when you're addressing review comments or when
pr-reply mode is active.

See `SKILL.md` for the full workflow documentation.

### Key Concepts

- **Thread-by-thread review**: Iterate through all review comments systematically
- **LLM analysis**: Understand reviewer intent and get recommendations
- **Flexible responses**: Implement fixes (with/without TDD), post replies, or defer
- **Automatic commit linking**: Commits are linked to threads, SHAs in replies
- **Stack awareness**: Rebase dependent PRs after making changes

### Related Skills

- `tdd-workflow` — Coordinates with pr-reply for test-driven implementations
- `git-commit-format` — Commit message conventions for review-driven changes
- `git-rebase-resolution` — Handles conflicts when rebasing stacks
- `pr-writing` — Writing good PR descriptions

### Related Extensions

- `extensions/pr-reply/` — The mode implementation
- `extensions/tdd-mode/` — Coordinates via events for test-driven fixes
- `extensions/plan-mode/` — Shares plan directory configuration
