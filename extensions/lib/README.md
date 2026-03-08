# Library

Common components used across extensions.

- **content-renderer** — Themed rendering of markdown, diffs,
  and code into display-ready lines. Includes a standalone
  `showContent` viewer for scrollable panels.
- **panel** — Single-shot (`showPanel`) and multi-page
  (`showPanelSeries`) UI components with scrollable content,
  numbered options with descriptions, inline editor, and
  horizontal scrolling for long lines.
- **gate** — Approval gate dialog (thin wrapper over panel
  that auto-appends a "Steer" option with inline editor).
- **review-loop** — Generic approve/edit/steer/reject cycle
  for guardian review flows. Supports single-field editing
  (commit messages), title+body editing (PRs, issues), and
  no-edit flows (history-guardian).
- **command-parse** — Bash command parsing utilities for
  guardian extensions — flag extraction, heredoc parsing,
  command splitting, and gh command reconstruction.
- **state** — Session state helpers for persisting extension
  state across conversation turns.
