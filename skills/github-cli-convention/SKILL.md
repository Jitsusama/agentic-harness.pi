---
name: github-cli-convention
description: >
  Command syntax for GitHub CLI operations. Heredoc format
  for PR and issue bodies, title conventions and metadata
  flags. Use when running gh pr create, gh issue create or
  any gh command with structured input.
---

# GitHub CLI Conventions

## Heredoc Syntax for Body Content

Use `--body-file -` with a heredoc to pass multi-line bodies:

```bash
gh pr create \
  --title "Add Token Refresh to Prevent Session Timeouts" \
  --body-file - <<'EOF'
### 🔍 What We're Doing

Body content here. Backticks and special characters all
work reliably without escaping.
EOF
```

The single-quoted `'EOF'` delimiter prevents shell variable
expansion; backticks, dollar signs and special characters
all pass through literally.

**Never use an unquoted heredoc delimiter.** `<<EOF` allows
shell variable expansion: `$variables`, backticks and
`$(commands)` are expanded inside the body, corrupting
the content. Always quote the delimiter: `<<'EOF'`.

Because quoted heredocs are fully literal, never put
`$variable` syntax in the body expecting it to resolve.
It won't — the text arrives exactly as written. If you
need a dynamic value, write the actual value directly
in the body text.

**Never use `--body-file` with a file path.** Always use
`--body-file -` to pipe from a heredoc. File-based bodies
add an unnecessary intermediate artifact and bypass the
guardian review flow.

The same pattern works for editing:

```bash
gh pr edit NUMBER \
  --body-file - <<'EOF'
Updated body content here.
EOF
```

And for issues:

```bash
gh issue create \
  --title "Add Rate Limiting to Prevent API Abuse" \
  --body-file - <<'ISSUE_BODY'
Body content here.
ISSUE_BODY
```

## Title Conventions

- Use Title Case, not lowercase or sentence case.
- Describe the outcome, not the task.
- 50–72 characters.
- Formula: `[Action] [What] [For What Purpose]`

Good: "Add Rate Limiting to Prevent API Abuse"
Bad: "rate limiting work"

For PRs, use descriptive titles, not conventional commit
format. "Add Token Refresh to Prevent Session Timeouts"
rather than "feat(auth): implement refresh token logic".

## Metadata in Separate Commands

After creating or editing, assign metadata in separate
commands; don't pack flags into the create command:

```bash
gh pr edit NUMBER --add-assignee @me
gh pr edit NUMBER --add-label "label1" --add-label "label2"
```

```bash
gh issue edit NUMBER --add-label "label1"
gh issue edit NUMBER --add-assignee @me
```

This keeps the create command focused on title and body.

## Line Wrapping in Bodies

Do NOT hard-wrap PR or issue body paragraphs. Write each
paragraph as a single continuous line. GitHub's markdown
renderer handles the wrapping; hard line breaks within a
paragraph render as visible breaks, making the text choppy.

Hard-wrapping at 72 characters is for **commit messages only**
(terminals don't reflow those). PR and issue bodies are
rendered by GitHub's markdown engine, which reflows paragraphs
automatically.

## Why --body-file Over --body

The `--body` flag has quoting issues:

- Markdown with backticks conflicts with shell quoting.
- Special characters may be mangled.
- Multi-line content is awkward.

`--body-file -` with heredoc avoids all of these. Always
prefer it for bodies with any formatting.

Do not use `--body-file` with a file path either. Always
use `--body-file -` piped from a heredoc.

The `github-pr-format` and `github-issue-format` skills cover the
*content* of descriptions. This skill covers the command
mechanics.
