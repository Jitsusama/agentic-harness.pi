---
name: conventional-commits
description: >
  Conventional commit message format, types, and line length rules.
  Use when writing commit messages, discussing commit conventions,
  or preparing to commit changes.
---

# Conventional Commits

Follow the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification.

## Format

Always use heredoc syntax for commits:

```bash
git commit -F- <<'EOF'
type(scope): subject line

Body explaining what and why, hard-wrapped at 72 characters.
Any additional paragraphs separated by blank lines.

BREAKING CHANGE: description if applicable
EOF
```

## Subject Line

- Format: `type(scope): description`
- Maximum 50 characters
- Scope is optional but encouraged
- Use imperative mood: "add", "fix", "change" — not "added", "fixes"
- No period at the end

## Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace — no logic change |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests |
| `build` | Build system or dependencies |
| `ci` | CI configuration |
| `chore` | Maintenance, tooling, config |
| `revert` | Reverting a previous commit |

## Body

- Blank line between subject and body
- Hard-wrap at 72 characters
- Explain **what** changed and **why**, not how
- **Be accurate about scope.** Only describe what this commit
  actually does — not what the larger feature will do. If this
  commit adds a service but doesn't wire it up, don't say it
  "handles transitions" or "processes events." Describe the
  concrete capability that exists after this commit.
- **Don't reference future work.** The commit message is about
  this commit, not what comes next. No "subsequent cycles will
  add…" or "a follow-up will wire this up."
- Don't parrot the implementation. If the diff shows a method
  that calls `.to_date.iso8601.uniq.sort`, don't write "convert
  timestamps to dates, deduplicate, and sort." Instead explain
  why this code exists and what problem it solves.
  - Bad: "Update auth.ts to add a refreshToken function and call
    it from the middleware"
  - Bad: "Convert timestamps to YYYY-MM-DD, deduplicate, sort,
    and pass to chunk!"
  - Good: "Support token refresh for long-lived sessions. Without
    this, users with sessions longer than 1 hour are forced to
    re-authenticate."
- Multiple paragraphs separated by blank lines

## Breaking Changes

- Add `!` after type/scope: `feat(api)!: remove v1 endpoints`
- And/or add a `BREAKING CHANGE:` footer in the body
- Describe what breaks and what consumers should do instead

## Scopes

Use scopes that match the project's domain. If the project's
AGENTS.md defines scopes, use those. Otherwise, infer from the
directory or module structure.
