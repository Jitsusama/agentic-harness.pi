# PR Review Extension

Deeply-contextualized, two-phase review experience for pull
requests. Crawls linked issues, cross-references, and source
files up to 5 levels deep, then generates AI-powered review
comments that the user interacts with in a polished TUI.

## How It Works

The agent calls the `pr_review` tool with different actions:

1. **Activate** — resolve repo on disk, crawl deep context
   (PR metadata, diff, issues, references, source files,
   reviewers)
2. **Generate comments** — agent analyzes the context and
   provides synopsis, scope analysis, source file roles,
   and structured review comments
3. **Overview** — Phase 1 panel with Overview, References,
   and Source tabs
4. **Review** — Phase 2 panel with Desc, Scope, and per-file
   tabs. Each tab has three views: overview (diff), comments
   (selectable list), and raw (full file)
5. **Submit** — review summary with verdict and comment counts
6. **Post** — submit the review to GitHub
7. **Deactivate** — clean up and exit

## Review Comments

All comments use [Conventional Comments](https://conventionalcomments.org/)
format with labels (praise, suggestion, issue, etc.),
decorations (blocking, non-blocking), and categories
(file, title, scope).

Users approve or reject each comment in the review panel.
Only approved comments are posted. Tabs auto-complete when
all their comments are resolved.

## Deep Context Crawling

The crawler follows references recursively:
- Level 0: PR itself (metadata, diff, reviewers)
- Level 1: Linked issues (parent/sub-issues, comments)
- Levels 2-4: References found in issue/PR bodies
- Level 5: Stop with depth limit warning

Source file discovery uses `rg` to find imports, reverse
imports, and test files for changed files.

## Design Notes

**Workspace prompt**: The review panel uses a shared
`workspace()` primitive (in `lib/ui/`) for stateful tabbed
interaction with per-view input handlers and external tab
status tracking.

**No `enforce.ts`**: The review workflow is inherently
read-only. Phase tracking is for UI display and context
injection, not for constraint enforcement.
