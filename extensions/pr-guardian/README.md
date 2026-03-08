# PR Guardian

Gates `gh pr create` and `gh pr edit` commands, showing the
formatted PR description (title + body) for user review before
execution.

## What It Does

When the agent runs a `gh pr create` or `gh pr edit --body` command,
PR Guardian intercepts it and presents the content in a review gate
with four options:

- **Approve** — execute the command as-is (or with edits)
- **Edit** — open an inline editor to modify the title and body
- **Steer** — provide feedback and send the agent back to revise
- **Reject** — block execution entirely

## Supported Command Formats

- `gh pr create --title "..." --body-file - <<'EOF'...EOF`
- `gh pr create --title "..." --body "..."`
- `gh pr edit N --body-file - <<'EOF'...EOF`
- `gh pr edit N --body "..."`

Commands without a body (e.g. `gh pr edit --add-label`) pass
through without a gate.
