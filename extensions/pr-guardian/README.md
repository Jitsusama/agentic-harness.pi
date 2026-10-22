# PR Guardian

Gates `gh pr create` and `gh pr edit` commands, showing the
formatted PR description (title + body) for your review before
execution.

## What It Does

When the agent runs a `gh pr create` or `gh pr edit --body`
command, PR Guardian intercepts it. The `pr` guard redirects by
default: the command runs and the title and body appear in the
transcript. Switched to block (`/guards pr block`), it presents
the content in a review gate with four options:

- **Approve**: execute the command as-is (or with edits).
- **Edit**: open an inline editor to modify the title and body.
- **Steer**: provide feedback and send the agent back to revise.
- **Reject**: block execution entirely.

The `sections`, `titles`, `prose` and `host` form guards refuse a
body, title or host that breaks the convention, whatever mode
`pr` is in. See
[guard-policy-workflow](../guard-policy-workflow/README.md).
The `sections` guard holds a body to its headings and to its
shape: the word, sentence, code-span and bullet limits the
`github-pr-format` skill sets for each section.

## The Audit After Publishing

A form guard switched to off or redirect, or one that relents on
a repeat, lets a description through that breaks its shape. So once a
`gh pr create` or `gh pr edit` has run, the guardian reads the
description it published and, when it is out of shape, tells the
agent in the same run to fix it with `review_offer edit`. It never
blocks, since the command has already run, which is why it works
in every guard mode. Each description's problems are said once.
`gh api` calls that write a body are not read.

## Supported Command Formats

- `gh pr create --title "..." --body-file - <<'EOF'...EOF`
- `gh pr create --title "..." --body "..."`
- `gh pr edit N --title "..." --body-file - <<'EOF'...EOF`
- `gh pr edit N --body "..."`

A title-only edit (e.g., `gh pr edit N --title "..."`) is gated
on its title. Commands with neither a body nor a title (e.g.,
`gh pr edit --add-label`), and bodyless creates, pass through
without a gate.
