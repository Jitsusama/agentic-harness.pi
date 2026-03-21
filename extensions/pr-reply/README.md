## PR Reply Extension

Mode for responding to GitHub PR review feedback. The LLM
drives the workflow by calling `pr_reply` with different
actions, analyzing threads in batch and presenting a
workspace for the user to navigate and act on threads.

### Architecture

**Pattern**: Multi-step tool + mode + workspace. The LLM
calls the tool repeatedly, advancing through the review
workflow. The workspace provides a tabbed interface for
browsing reviewer feedback.

### Workflow

```
activate → generate-analysis → review → (implement|reply) → done → generate-analysis → review → ... → deactivate
```

After activation, the LLM analyzes all threads at once and
provides per-thread recommendations via `generate-analysis`.
The workspace shows reviewer tabs where the user browses
threads and chooses actions. After each implementation or
reply, the LLM re-analyzes remaining threads with fresh
code context before reopening the workspace.

### Workspace

- **Summary tab**: PR overview, progress tracker.
- **Reviewer tabs** (one per reviewer) with three views:
  - `[o] Overview`: reviewer comment, thread summary list.
  - `[t] Threads`: selectable list with recommendations.
  - `[s] Source`: code context around selected thread.

Thread actions (implement/reply/defer/skip) are available
in the Threads view. Defer and skip are handled inline.
Implement and reply dismiss the workspace for the LLM to
work, then reopen after re-analysis.

### Tool Actions

| Action | Purpose |
|--------|---------|
| `activate` | Load PR, show summary, enter mode |
| `generate-analysis` | Batch pre-analyze all threads |
| `review` | Show/reopen the workspace |
| `implement` | Begin implementing current thread |
| `reply` | Post a reply to current thread |
| `done` | Mark implementation complete, post reply |
| `skip` | Skip thread |
| `defer` | Defer thread for later |
| `deactivate` | Exit mode, report results |

### Coordinates With

- **TDD mode**: listens for `tdd_phase` done/stop events
  and automatically collects commits and links them to threads.
- **Plan mode**: shares plan directory for context-aware
  analysis.

### Related Skills

- `tdd-workflow`: coordinates with pr-reply for test-driven implementations.
- `git-commit-format`: commit message conventions for review-driven changes.
- `git-rebase-resolution`: handles conflicts when rebasing stacks.
- `pr-writing`: writing good PR descriptions.

### Related Extensions

- `extensions/pr-reply/`: the mode implementation.
- `extensions/tdd-mode/`: coordinates via events for test-driven fixes.
- `extensions/plan-mode/`: shares plan directory configuration.

### Design Notes

**Re-analysis after state changes**: After each `done` or
`reply`, the LLM re-analyzes all remaining pending threads
with fresh code context. This prevents stale recommendations
when implementation of one thread changes code that other
threads comment on.

**Workspace dismiss/restore**: The workspace saves its
position (which tab, which thread selected) so that after
implementation the user returns to where they left off.
