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
| `review-files` | Start file-by-file review |
| `next-file` | Advance to next file |
| `add-comment` | Add a structured review comment |
| `resume` | Return to current phase after breakout |
| `vet` | Enter final vetting |
| `post` | Submit the review to GitHub |
| `deactivate` | Clean up and exit |

## Standard Sequence

```
activate → context → description → analyze → review-files
→ (next-file)* → vet → post → deactivate
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

Call `description` to evaluate the PR description. Consider:

- Does the title accurately describe the change?
- Is the description complete as a historic record?
- Is the scope appropriate? Should this be split?
- Does the description match the actual changes?

Add any description-level comments with `add-comment`.

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

### 5. File-by-File Review

Call `review-files` to start. The tool returns each file's
diff one at a time. For each file:

1. Read the full file from the worktree for context
2. Search for similar patterns in the codebase
3. Draft comments with `add-comment`
4. Call `next-file` when done

### 6. Final Vetting

Call `vet` to see all collected comments. Present them to the
user for approval. The tool suggests a verdict based on
whether any comments are blocking.

### 7. Post

Call `post` to submit the review to GitHub with the chosen
verdict (APPROVE, REQUEST_CHANGES, or COMMENT).

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

The user can break out to conversation at any point. When
they return, call `resume` to pick up where you left off.

## What Not to Do

- Don't skip the context and description review steps
- Don't rush to file review without understanding the why
- Don't just agree with the PR author — evaluate critically
- Don't leave blocking feedback without constructive guidance
- Don't comment on style when conventions aren't violated
