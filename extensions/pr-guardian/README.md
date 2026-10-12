# PR Guardian

Gates `gh pr create` and `gh pr edit` commands, showing the
formatted PR description (title + body) for your review before
execution.

## What It Does

When the agent runs a `gh pr create` or `gh pr edit --body`
command, PR Guardian intercepts it. The `pr` guard reports by
default: the command runs and the title and body appear in the
transcript. Switched to block (`/guards pr block`), it presents
the content in a review gate with four options:

- **Approve**: execute the command as-is (or with edits).
- **Edit**: open an inline editor to modify the title and body.
- **Steer**: provide feedback and send the agent back to revise.
- **Reject**: block execution entirely.

The `sections`, `titles`, `prose` and `host` redirects refuse a
body, title or host that breaks the convention, whatever mode
`pr` is in. See
[guard-policy-workflow](../guard-policy-workflow/README.md).

## Supported Command Formats

- `gh pr create --title "..." --body-file - <<'EOF'...EOF`
- `gh pr create --title "..." --body "..."`
- `gh pr edit N --title "..." --body-file - <<'EOF'...EOF`
- `gh pr edit N --body "..."`

A title-only edit (e.g., `gh pr edit N --title "..."`) is gated
on its title. Commands with neither a body nor a title (e.g.,
`gh pr edit --add-label`), and bodyless creates, pass through
without a gate.
