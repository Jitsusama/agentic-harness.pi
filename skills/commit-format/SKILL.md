---
name: commit-format
description: >
  Conventional commit message structure: types, scopes,
  subject and body rules, and how to get the message into
  git. Use when writing a commit message. Pairs with
  git-commit-convention for when to commit and what belongs
  in one. Follow the user's writing voice and prose style
  guides for body text.
---

# Conventional Commits

Follow the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification.

## Format

## Subject Line

- Format: `type(scope): description`
- Maximum 50 characters
- Scope is optional but encouraged
- Use imperative mood: "add", "fix", "change" (not "added", "fixes")
- No period at the end

## Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace (no logic change) |
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
  actually does, not what the larger feature will do. If this
  commit adds a service but doesn't wire it up, don't say it
  "handles transitions" or "processes events." Describe the
  concrete capability that exists after this commit.
- **Don't reference future work.** The commit message is about
  this commit, not what comes next. No "subsequent cycles will
  add ..." or "a follow-up will wire this up."
- Don't parrot the implementation. If the diff shows a method
  that calls `.to_date.iso8601.uniq.sort`, don't write "convert
  timestamps to dates, deduplicate and sort." Instead explain
  why this code exists and what problem it solves.
  - Bad: "Update auth.ts to add a refreshToken function and call
    it from the middleware"
  - Bad: "Convert timestamps to YYYY-MM-DD, deduplicate, sort
    and pass to chunk!"
  - Good: "Support token refresh for long-lived sessions. Without
    this, users with sessions longer than 1 hour are forced to
    re-authenticate."
- Multiple paragraphs separated by blank lines
- The body is prose; it follows `prose-standard`. No emdashes,
  Canadian spelling, and no markdown decoration: commit messages
  are read in plain terminals where backticks and asterisks
  render as literal characters, so symbol names, paths and
  identifiers appear as plain prose, not code spans.

## URI Indexing

When the body cites a URI, index it rather than inlining the raw
link. Place a numbered marker inline (`[1]`) and a `[1]:
https://...` line in a footer block at the end of the body. A
bare URL in the middle of a paragraph breaks the 72-character
wrap and reads as noise in `git log`; the footer keeps the prose
clean and the link recoverable.

## Breaking Changes

- Add `!` after type/scope: `feat(api)!: remove v1 endpoints`
- And/or add a `BREAKING CHANGE:` footer in the body
- Describe what breaks and what consumers should do instead

## Scopes

Use scopes that match the project's domain. If the project's
AGENTS.md defines scopes, use those. Otherwise, infer from the
directory or module structure.

## Getting the Message Into Git

Prefer the `work record` tool, which takes the subject and body as
arguments and needs no quoting at all. When committing through a
shell, pass the message on stdin with a quoted heredoc delimiter:

```bash
git commit -F- <<'EOF'
feat(auth): add token refresh

Why, not what.
EOF
```

The quotes around `'EOF'` are what stop the shell expanding
`$variable`, a backtick or `$(command)` inside the message. An
unquoted delimiter is refused, because the corruption is silent:
the commit lands with the expansion already applied and looks
fine until somebody reads it.

Staging in the same call is fine (`git add -A && git commit -F-
...`). Chaining a second reviewable command is not: each `git
commit`, `gh pr create` and `gh issue create` gets its own bash
call, and so does any state change like `git push` or `git
checkout`. Guardians rewrite the command they are reviewing, and a
compound call risks losing the parts that were not the target.

Never `--amend`. It is refused outright rather than reviewed: a
new commit is cleaner and keeps the work trail. This used to be
documented in a skill that also carried an `--amend` example, which
is how a rule and its counterexample lived three files apart for
months.
