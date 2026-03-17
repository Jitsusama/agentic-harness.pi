---
name: pr-review
description: >
  Pull request review workflow. How to gather context, analyze
  code, collect review comments, and post structured reviews.
  Use when reviewing someone else's PR.
---

# PR Review Workflow

## Philosophy

Understand the **why** before evaluating the **what**. Build
maximum context from the PR, its linked issues, and the
codebase, then review through that lens.

## Tool Actions

The `pr_review` tool drives the workflow through sequential
actions. Each call returns context for you to reason about,
then you call back with the next action.

| Action | Purpose |
|--------|---------|
| `activate` | Parse PR ref, create worktree, gather context |
| `context` | Show context summary (re-showable any time) |
| `description` | Review PR title, description, and scope |
| `analyze` | Get context for deep analysis |
| `review-files` | Tabbed file review (diff/file/comments per file) |
| `add-comment` | Add a structured review comment |
| `update-comment` | Edit an existing comment by ID |
| `remove-comment` | Delete a comment by ID |
| `resume` | Return to current phase after breakout |
| `vet` | Final vetting — user can post directly from panel |
| `post` | Submit the review (fallback if not posted from vet) |
| `deactivate` | Clean up and exit |

## Standard Sequence

```
activate → context → description → analyze → review-files
→ vet → deactivate
```

### 1. Activate and Gather Context

Call `activate` with a PR reference (URL, `#123`, or
`owner/repo#123`). The tool:
- Fetches PR metadata, diff, linked issues, sibling PRs
- Creates a git worktree if not on the PR branch
- Shows a live progress panel during gathering

### 2. Review Context

Call `context` to show the gathered context summary panel.
Read the overview, linked issues, and related PRs. This
gives you the full picture before commenting.

You can re-show context at any time by calling `context`
again.

### 3. Review Description and Scope

Call `description` to evaluate the PR description. The user
sees the title, description, scope stats, and linked issues.
They can steer to request comments on any of these.

If the user steers, draft a conventional comment addressing
their feedback using `add-comment`, then call `description`
again or `analyze` to proceed.

### 4. Deep Analysis

Call `analyze` to get the full context for deep analysis.
Then actively investigate:

1. **Read files** from the worktree for surrounding context
2. **Search the codebase** with `rg` for consistency patterns
3. **Assess test coverage** — behavior vs implementation tests
4. **Evaluate the implementation** — readability, abstraction,
   naming, composition

Use the `code-review-criteria` skill for evaluation guidance.

Draft preliminary comments with `add-comment` as you find
things worth raising.

### 5. Tabbed File Review

Call `review-files` to open a tabbed panel with one tab per
changed file. The user navigates freely between files and
switches between three views per file:

- **Diff** (`d`) — unified diff with comment summary
- **File** (`f`) — full file from worktree, syntax highlighted
- **Comments** (`c`) — detailed list of comments on this file

The user steers to request comments on specific files. When
they steer, draft a conventional comment and call `add-comment`,
then call `review-files` again to re-show the panel.

When the user finishes (presses done), the tool returns a
summary of all comments collected.

### 6. Comment Management

Use these actions to manage the review comment collection:

- `add-comment` — create a new comment with `file`, `startLine`,
  `endLine`, `label`, `decorations`, `subject`, `discussion`
- `update-comment` — edit an existing comment by `comment_id`
  with a `comment` object containing the updated fields
- `remove-comment` — delete a comment by `comment_id`

### 7. Final Vetting

Call `vet` to show all collected comments in a tabbed panel.
The summary tab shows the review body, verdict, and stats.
Each comment tab shows full details.

The user can:
- Approve or reject individual comments
- Steer to edit the verdict or review body
- Post the review directly from the summary tab

If the user steers during vetting to change a comment, use
`update-comment` with the comment ID and revised fields,
then call `vet` again.

If the user posts from the panel, the handler submits to
GitHub automatically. Otherwise, call `post` as a fallback.

### 8. Deactivate

Call `deactivate` to clean up the worktree and exit review
mode.

## Comment Format

Use the `conventional-comments` skill for formatting. All
comments use structured conventional comments with labels,
decorations, and a teaching-oriented tone.

When calling `add-comment`, provide:
- `file` — file path
- `startLine` / `endLine` — line range
- `label` — conventional comment label
- `decorations` — `["blocking"]` or `["non-blocking"]`
- `subject` — one-line summary
- `discussion` — detailed explanation

## Conversation Breakout

The user can break out to conversation at any point using
Shift+Enter in any panel. When they return, call `resume`
to pick up where you left off. During file review, `resume`
re-opens the tabbed file panel.

## What Not to Do

- Don't skip the context and description review steps
- Don't rush to file review without understanding the why
- Don't just agree with the PR author — evaluate critically
- Don't leave blocking feedback without constructive guidance
- Don't comment on style when conventions aren't violated
- Don't add duplicate comments — use `update-comment` to edit
