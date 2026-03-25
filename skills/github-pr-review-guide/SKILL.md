---
name: github-pr-review-guide
description: >
  Pull request review workflow. How to gather context, analyze
  code, collect review comments and post structured reviews.
  Use when reviewing someone else's PR.
---

# PR Review Workflow

## Philosophy

Understand the **why** before evaluating the **what**. The
tool crawls deep context automatically (linked issues,
parent/sub-issues, cross-references up to 5 levels). You
analyze that context and generate structured comments, then
the user reviews them in an interactive panel.

## Tool Actions

The `pr_review` tool drives the workflow. Each call returns
context or shows a panel.

| Action | Purpose |
|--------|---------|
| `activate` | Parse PR ref, resolve repo, crawl deep context |
| `generate-analysis` | Provide synopsis, scope, roles and reference summaries |
| `generate-comments` | Provide structured review comments |
| `overview` | Show Phase 1 overview panel |
| `review` | Show Phase 2 review panel |
| `add-comment` | Add a review comment |
| `update-comment` | Edit an existing comment by ID |
| `remove-comment` | Delete comment(s) by ID or IDs |
| `list-comments` | Show all comments with their IDs |
| `submit` | Show final review summary panel |
| `post` | Submit review to GitHub |
| `deactivate` | Clean up and exit |

## Standard Sequence

```
activate → generate-analysis → overview
→ generate-comments → DISCUSS → overview
→ review → (steer cycles) → submit → post → deactivate
```

### 1. Activate and Gather

Call `activate` with a PR reference (URL, `#123`, or
`owner/repo#123`). The tool:
- Resolves the repo on disk.
- Crawls deep context (PR, diff, issues, references, source files, reviewers).
- Returns a comprehensive briefing with the full diff, issue
  context, reviewer status and source file list.

### 2. Generate Analysis

After receiving the activation briefing, analyze the PR
thoroughly. Use `read` to examine source files and `rg`
via `bash` to search for patterns. Then call
`generate-analysis` with:

- **`synopsis`**: a conversational, approachable summary
  for a human reviewer. Lead with the motivation, then
  explain the approach. Write like you're catching up a
  teammate, not a commit message or changelog entry.
- **`scope_analysis`**: markdown assessment of scope quality
  (focused? too broad? well-organized?).
- **`source_roles`**: for each discovered source file, one
  sentence explaining why it's relevant to the PR.
- **`reference_summaries`**: for each discovered reference,
  a one-sentence plain-language summary of what it is and
  why it matters to this PR (matched by URL).

Do **not** generate comments yet. The user gets a first
pass through the code before comments shape their thinking.

### 3. First Overview

After `generate-analysis`, call `overview` to show the
overview panel. The user sees the synopsis, categorised
references, and per-file tabs with Diff, Notes and Source
views. This is their first pass through the code.

The user can take notes on individual files during the
overview. When they press Ctrl+Enter to proceed, any
notes are included in the result text. If they steer,
process their feedback and call `overview` again.

### 4. Generate Comments

After the user finishes the overview, call
`generate-comments` with structured review comments
informed by your analysis and any user notes from the
overview:

- **`comments`**: structured review comments, each with:
  - `file` (path or null for PR-level)
  - `startLine`, `endLine` (or null for file-level)
  - `label`: conventional comment label
  - `decorations`: `["blocking"]`, `["non-blocking"]`, etc.
  - `subject`: one-line summary
  - `discussion`: detailed explanation
  - `category`: `"file"`, `"title"`, or `"scope"`

Use the `comment-format` and `code-review-standard`
skills for format and quality guidance.

If the user left notes during the overview, use them as
direction. Notes signal what the reviewer noticed and
cares about; generate comments that address those
observations where appropriate.

**Category rules:**
- `scope`: only about scope concerns (focus, organization).
- `title`: about title accuracy and description completeness.
- `file`: code quality, tests, implementation.

### 5. Conversation Phase

After `generate-comments`, comments are **proposed** (not
yet committed to the review). Present your review approach
conversationally:

1. Explain what the PR does and what the author's intent
   seems to be.
2. Describe the concerns you found and your review
   strategy.
3. If the user left notes, acknowledge which ones informed
   your comments and which you chose not to address.
4. Summarize the proposed comments at a high level.
5. Wait for the user to respond.

During conversation:
- When the user gives feedback, **research first**: read
  files, search patterns, check linked issues. Don't jump
  to modifying comments without context.
- Use `list-comments` to see all comments with their IDs.
- Use `update-comment`, `remove-comment` (supports arrays
  via `comment_ids`), and `add-comment` to adjust.
- New comments added during discussion also start as
  proposed.

When the user is satisfied (e.g., "looks good", "proceed",
"let's review"), call `overview` to promote proposed
comments to pending and begin the structured review.

### 6. Second Overview

Call `overview` again to promote proposed comments to
pending. The user can do a second pass through the code
if they wish, now with the comments finalised. After the
overview, call `review` to show the review panel.

### 7. Review Phase

Call `review` to show the review panel. One tab per changed
file plus Desc and Scope tabs. Each tab has three views:

- **Overview** (`o`): diff with comment indicators.
- **Comments** (`c`): selectable comment list with
  approve/reject/steer actions.
- **Source** (`s`): full file content.

The user reviews comments, approves/rejects them and can
steer for changes. Tabs auto-complete when all comments
are resolved. 'h' manually marks a tab handled.

If the user steers:
- On a comment: they want it edited; use `update-comment`
  then call `review`.
- For a new comment: they want one added; use `add-comment`
  then call `review`.
- General feedback: process and call `review`.

### 8. Submit Phase

Call `submit` to show the submit panel. You can optionally
provide `review_body` and `verdict` to pre-fill.

The user sees the review summary with verdict, comment
counts and approved comments. They can post directly or
steer to edit the body/verdict.

If they steer, update `review_body`/`verdict` and call
`submit` again.

### 9. Post and Deactivate

The submit panel's post action calls `post` automatically.
If needed, call `post` directly. Then call `deactivate`
to exit review mode.

## Complexity Adaptation

For small PRs (1-3 files, few changes), generate fewer
comments. Don't force the user through every phase if the
PR is straightforward; a simple review might skip straight
from `generate-comments` to `submit`.

For large PRs, be thorough. Use the source file discovery
to understand the full impact and generate comments across
multiple categories.

## Steer Handling

When a panel returns steer feedback:
1. Read the user's note.
2. Take the appropriate action (update comment, add comment,
   change verdict, investigate further).
3. Re-open the same panel by calling the same action.

The steer note includes context about what was being viewed.

When the user gives qualitative feedback during conversation
(before the overview panel), always research first: read the
relevant code, check linked issues and search for patterns.
Build context before proposing or modifying comments.

## What Not to Do

- Don't skip the analysis; read source files, search patterns.
- Don't generate low-quality placeholder comments.
- Don't ignore steer feedback; the user is directing you.
- Don't comment on style when conventions aren't violated.
- Don't leave blocking feedback without constructive guidance.
- Don't add duplicate comments; use `update-comment` to edit.
- Don't guess comment IDs; use `list-comments` to discover them.
- Use `comment_ids` (array) with `remove-comment` for bulk removal.
