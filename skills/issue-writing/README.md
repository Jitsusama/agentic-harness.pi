# Issue Writing Skill

Teaches the agent how to write clear GitHub issues and use the
CLI heredoc format that avoids character escaping problems.

## What It Covers

- Issue title conventions (Title Case, 50–72 chars)
- Heredoc CLI format (`--body-file - <<'ISSUE_BODY'`) for
  reliable special character handling
- Metadata management in separate commands

## Paired Extension

The **issue-guardian** extension enforces a review gate on
`gh issue create` and `gh issue edit` commands, letting you
approve, edit, steer or reject before execution.
