---
name: git-cli-convention
description: >
  Git command formatting. Heredoc syntax, shell quoting and
  commit command patterns. Use when formatting git commands
  or writing heredocs.
---

# Git CLI Conventions

## Heredoc Syntax for Commits

Use `-F-` with a heredoc to pass multi-line commit messages:

```bash
git commit -F- <<'EOF'
type(scope): subject line

Body explaining what and why, hard-wrapped at 72 characters.
Any additional paragraphs separated by blank lines.
EOF
```

The single-quoted `'EOF'` delimiter prevents shell variable
expansion; backticks, dollar signs and special characters
all pass through literally.

## Why Heredoc Over -m

The `-m` flag has limitations:

- Multi-line messages require multiple `-m` flags.
- Special characters need escaping.
- Quoting gets fragile with nested quotes.

Heredoc avoids all of these. Always prefer `-F-` with heredoc
for commits with a body.

## Shell Quoting

When constructing git commands:

- Single-quote strings that should be literal: `'no $expansion'`
- Double-quote strings that need variable expansion: `"branch: $name"`
- Escape double quotes inside double-quoted strings: `"say \"hello\""`
- For strings containing single quotes, use double quotes:
  `"it's fine"`

## Commit Command Patterns

Common patterns the agent should use:

```bash
# Simple commit with heredoc
git commit -F- <<'EOF'
feat(auth): add token refresh
EOF

# Commit with flags
git commit --amend -F- <<'EOF'
fix(api): correct response parsing
EOF

# Staged commit with prefix commands
git add -A && git commit -F- <<'EOF'
chore: update dependencies
EOF
```

The `commit-format` skill covers the message format
itself (types, scopes, subject/body rules). This skill
covers the command mechanics.

## One Concern Per Bash Call

Never combine git state changes with other commands in
a single bash call. Guardians and interceptors rewrite
commands during review, and compound commands risk
losing parts that aren't part of the target command.

**Bad** (checkout may be dropped by the PR guardian):
```bash
git checkout feature-branch
gh pr create --title "..." --body-file - <<'EOF'
...
EOF
```

**Good** (separate calls, verified):
```bash
git checkout feature-branch
```
```bash
git branch --show-current  # verify before depending on it
```
```bash
gh pr create --title "..." --body-file - <<'EOF'
...
EOF
```

The same applies to any git state change (checkout,
pull, reset, stash) followed by a command that depends
on that state. Always verify the state change took
effect in a separate call before proceeding.
