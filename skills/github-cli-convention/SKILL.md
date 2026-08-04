---
name: github-cli-convention
description: >
  Command syntax for GitHub CLI operations. Heredoc format
  for PR and issue bodies, title conventions and metadata
  flags. Use when running gh pr create, gh issue create or
  any gh command with structured input.
---

# GitHub CLI Conventions

This is the companion to the GitHub review provider. `gh` talks
to GitHub and nothing else, so none of it applies to a change
hosted somewhere GitHub is not.

Before reaching for `gh` against a repository, check which system
owns it. A checkout can carry a GitHub remote that is a read-only
mirror of the real thing, and a review posted to a mirror
succeeds and is read by nobody. `review capabilities` says which
provider answers for a change, and `review-guide` covers reading
and reviewing without assuming a forge.

Worse than a mirror that answers: a change the mirror has never
heard of. A pull request created on a non-GitHub backend exists
only there, so `gh` cannot see it at all, whatever host and repo
you spell out. Asking anyway gets you

```
Could not resolve to a PullRequest with the number of 2001696.
```

which reads as a wrong number and is nothing of the kind. Do not
respond by hunting for the right number or the right `-R`: there
is none. Reach for `review_offer edit`, which asks the system
that actually holds the change.

Prefer the tool to the CLI where it reaches. `review_offer
propose` opens a change, `edit` changes its title, body or base,
and `add` and `set` handle labels and assignees, on whichever
system hosts the repo and without the host and repo spelled out.
Reach for `gh` when you want something the tool does not cover,
which is mainly issues, projects and sub-issues. What follows is
the mechanics for that case.

## Heredoc Syntax for Body Content

Use `--body-file -` with a heredoc to pass multi-line bodies:

```bash
gh pr create \
  --title "Add Token Refresh to Prevent Session Timeouts" \
  --body-file - <<'EOF'
### 🌐 Situation

Body content here. Backticks and special characters all
work reliably without escaping.

### 🔧 Resolution

What the change does about it.

### 🔬 Validation

How you know it worked.
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
It won't; the text arrives exactly as written. If you
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
- Aim for 50 to 72 characters. The upper bound is enforced; the
  lower bound is guidance. Past 72 characters the title truncates
  in GitHub views and reads badly in logs, so the gate blocks it.
  Short descriptive titles below 50 are fine when they say what
  needs to be said ("Add Dark Mode Toggle" is 20 characters and
  clear); the lower bound is a nudge, not a wall.
- Formula: `[Action] [What] [For What Purpose]`

Good: "Add Rate Limiting to Prevent API Abuse"
Bad: "rate limiting work"

For PRs, use descriptive titles, not conventional commit
format. "Add Token Refresh to Prevent Session Timeouts"
rather than "feat(auth): implement refresh token logic".

## Keep the Command Reachable

Every `gh pr` and `gh issue` create or edit is reviewed and has an
attribution footer spliced into its body before it runs. Both of
those need to find the command, so it has to be issued plainly:
not wrapped in command substitution (`$(gh pr create ...)`), not
inside a subshell, and not on either side of a pipe. A wrapped
command is blocked rather than run unattributed, and the message
says so, but the reason reads oddly if you did not know
attribution was happening at all.

This is also why metadata goes in separate calls, below, and why a
commit and a `gh` command never share a bash call.

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

The section set in the example above is not decoration: it is
closed and enforced, and a body carrying any other heading is
blocked. This example used to show `### 🔍 What We're Doing`,
which no gate would have let through, so the one command in the
file a reader is most likely to copy was the one that could not
run.
