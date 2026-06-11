# Issue Guardian

Gates `gh issue create` and `gh issue edit` commands, showing
the formatted issue description (title + body) for your review
before execution.

## What It Does

When the agent runs a `gh issue create` or `gh issue edit
--body` command, Issue Guardian intercepts it and presents the
content in a review gate with four options:

- **Approve**: execute the command as-is (or with edits).
- **Edit**: open an inline editor to modify the title and body.
- **Steer**: provide feedback and send the agent back to revise.
- **Reject**: block execution entirely.

## Supported Command Formats

- `gh issue create --title "..." --body-file - <<'EOF'...EOF`
- `gh issue create --title "..." --body "..."`
- `gh issue edit N --title "..." --body-file - <<'EOF'...EOF`
- `gh issue edit N --body "..."`

A title-only edit (e.g., `gh issue edit N --title "..."`) is
gated on its title. Commands with neither a body nor a title
(e.g., `gh issue edit --add-label`), and bodyless creates, pass
through without a gate.
