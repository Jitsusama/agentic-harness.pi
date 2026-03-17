---
name: pr-review
description: >
  Pull request review workflow. How to gather context, analyze
  code, collect review comments, and post structured reviews.
  Use when reviewing someone else's PR.
---

# PR Review Workflow

## Philosophy

Understand the **why** before evaluating the **what**. The
tool crawls deep context automatically — linked issues,
parent/sub-issues, cross-references up to 5 levels. You
analyze this context and generate structured comments that
the user then reviews in an interactive panel.

## Tool Actions

The `pr_review` tool drives the workflow. Each call returns
context or shows a panel.

| Action | Purpose |
|--------|---------|
| `activate` | Parse PR ref, resolve repo, crawl deep context |
| `generate-comments` | Provide analysis, synopsis, and comments |
| `overview` | Show Phase 1 overview panel |
| `review` | Show Phase 2 review panel |
| `add-comment` | Add a review comment |
| `update-comment` | Edit an existing comment by ID |
| `remove-comment` | Delete a comment by ID |
| `submit` | Show final review summary panel |
| `post` | Submit review to GitHub |
| `deactivate` | Clean up and exit |

## Standard Sequence

```
activate → generate-comments → overview → review
→ (steer cycles) → submit → post → deactivate
```

### 1. Activate and Gather

Call `activate` with a PR reference (URL, `#123`, or
`owner/repo#123`). The tool:
- Resolves the repo on disk
- Crawls deep context (PR, diff, issues, references, source files, reviewers)
- Returns a comprehensive briefing with the full diff, issue
  context, reviewer status, and source file list

### 2. Generate Comments

After receiving the activation briefing, analyze the PR
thoroughly. Use `read` to examine source files and `rg`
via `bash` to search for patterns. Then call
`generate-comments` with:

- **`synopsis`** — 1-2 paragraph summary of what the PR
  does and why
- **`scope_analysis`** — markdown assessment of scope quality
  (focused? too broad? well-organized?)
- **`source_roles`** — for each discovered source file, one
  sentence explaining why it's relevant to the PR
- **`comments`** — structured review comments, each with:
  - `file` (path or null for PR-level)
  - `startLine`, `endLine` (or null for file-level)
  - `label` — conventional comment label
  - `decorations` — `["blocking"]`, `["non-blocking"]`, etc.
  - `subject` — one-line summary
  - `discussion` — detailed explanation
  - `category` — `"file"`, `"title"`, or `"scope"`

Use the `conventional-comments` and `code-review-criteria`
skills for format and quality guidance.

**Category rules:**
- `scope` — only about scope concerns (focus, organization)
- `title` — about title accuracy and description completeness
- `file` — code quality, tests, implementation

### 3. Overview Phase

Call `overview` to show the overview panel. The user sees
three tabs: Overview (PR metadata + synopsis), References
(browsable list of all crawled references), and Source
(browsable list of source files with roles).

The user presses 'r' to proceed to review, or steers for
feedback. If they steer, process their feedback and call
`overview` again.

### 4. Review Phase

Call `review` to show the review panel. One tab per changed
file plus Desc and Scope tabs. Each tab has three views:

- **Overview** (`o`) — diff with comment indicators
- **Comments** (`c`) — selectable comment list with
  approve/reject/steer actions
- **raW** (`w`) — full file content

The user reviews comments, approves/rejects them, and can
steer for changes. Tabs auto-complete when all comments
are resolved. 'h' manually marks a tab handled.

If the user steers:
- On a comment: they want it edited — use `update-comment`
  then call `review`
- For a new comment: they want one added — use `add-comment`
  then call `review`
- General feedback: process and call `review`

### 5. Submit Phase

Call `submit` to show the submit panel. You can optionally
provide `review_body` and `verdict` to pre-fill.

The user sees the review summary with verdict, comment
counts, and approved comments. They can post directly or
steer to edit the body/verdict.

If they steer, update `review_body`/`verdict` and call
`submit` again.

### 6. Post and Deactivate

The submit panel's post action calls `post` automatically.
If needed, call `post` directly. Then call `deactivate`
to exit review mode.

## Complexity Adaptation

For small PRs (1-3 files, few changes): generate fewer
comments. Don't force the user through every phase if the
PR is straightforward. A simple review might skip straight
from `generate-comments` to `submit`.

For large PRs: be thorough. Use the source file discovery
to understand the full impact. Generate comments across
multiple categories.

## Steer Handling

When a panel returns steer feedback:
1. Read the user's note
2. Take the appropriate action (update comment, add comment,
   change verdict, investigate further)
3. Re-open the same panel by calling the same action

The steer note includes context about what was being viewed.

## What Not to Do

- Don't skip the analysis — read source files, search patterns
- Don't generate low-quality placeholder comments
- Don't ignore steer feedback — the user is directing you
- Don't comment on style when conventions aren't violated
- Don't leave blocking feedback without constructive guidance
- Don't add duplicate comments — use `update-comment` to edit
