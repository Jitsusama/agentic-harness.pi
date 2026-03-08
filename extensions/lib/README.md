# Library

Common components used across extensions, organized by layer.

## `ui/`

- **panel** — Single-shot (`showPanel`) and multi-page
  (`showPanelSeries`) UI components with scrollable content,
  numbered options with descriptions, inline editor, and
  horizontal scrolling for long lines.
- **gate** — Approval gate dialog (thin wrapper over panel
  that auto-appends a "Steer" option with inline editor).
- **content-renderer** — Themed rendering of markdown, diffs,
  and code into display-ready lines. Includes a standalone
  `showContent` viewer for scrollable panels.

## `guardian/`

- **review-loop** — Generic approve/edit/steer/reject cycle
  for guardian review flows. Supports single-field editing
  (commit messages), title+body editing (PRs, issues), and
  no-edit flows (history-guardian).

## `parse/`

- **command** — Shell-level command parsing: flag extraction,
  heredoc parsing, quoting, and compound command splitting.
- **gh-command** — GitHub CLI domain: command detection,
  entity number extraction, multi-value flag extraction, and
  command rebuilding for gh pr/issue create/edit.

## Top-level

- **state** — Session state helpers for persisting extension
  state across conversation turns and injecting/filtering
  context messages.
