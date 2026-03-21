---
name: pr-reply
description: >
  Responding to GitHub PR review feedback. Workflow for analyzing
  review threads, implementing changes and posting replies with
  commit references. Use when addressing PR reviews or responding
  to reviewer feedback.
---

# PR Reply Workflow

## When to Use

Use pr-reply mode when a PR has review feedback to address:

- Reviewer left comments or requested changes.
- Multiple threads across different files.
- Mix of required changes and optional suggestions.
- Need to track which threads have been addressed.

## How It Works

The `pr_reply` tool manages the workflow through a series of
actions. You drive the conversation; the tool provides data
and tracks state.

### Step 1: Activate

Call `pr_reply` with action `activate` and a PR reference.

```
pr_reply(action: "activate", pr: "#123")
```

The tool fetches all reviews and threads, shows the user a
summary panel and returns all thread data for batch analysis.

### Step 2: Analyze All Threads

Analyze all threads at once, then provide your analysis:

```
pr_reply(action: "generate-analysis", analyses: [...], reviewer_analyses: [...])
```

For each thread, provide:
- `thread_id`: the thread ID from the activation data.
- `recommendation`: implement, reply, skip or defer.
- `analysis`: your reasoning (shown to the user in the
  workspace).

For each reviewer, provide:
- `reviewer`: their username.
- `assessment`: brief character assessment (thorough,
  nitpicky, collaborative, blocking, etc.).

### Step 3: Show Workspace

Call `pr_reply` with action `review` to show the workspace.
The user navigates reviewer tabs, browses threads and
chooses actions directly in the workspace.

The workspace has:
- **Summary tab**: PR overview, progress tracker.
- **Reviewer tabs** (one per reviewer) with:
  - `[o] Overview`: reviewer comment, thread summary list.
  - `[t] Threads`: selectable list with your recommendation.
  - `[s] Source`: code around the selected thread.

### Step 4: Handle Actions

The workspace returns the user's chosen action:

**Implement** (code changes needed):
```
pr_reply(action: "implement", use_tdd: true)
```
Make changes, run tests, commit. Then:
```
pr_reply(action: "done", reply_body: "Extracted validation as suggested. abc1234")
```

**Reply** (no code changes):
```
pr_reply(action: "reply", reply_body: "Good point; I'll address this in a follow-up.")
```

**Skip and Defer** are handled inline in the workspace;
the user presses `k` or `d` directly.

After any action, call `review` to reopen the workspace:
```
pr_reply(action: "review")
```

### Step 5: Deactivate

When all threads are done:
```
pr_reply(action: "deactivate")
```

## Analyzing Threads

Your job is to think critically, not to agree with the
reviewer by default. The user trusts your judgement; give
them a real opinion, not a summary of what happened.

**What they're actually asking**: Read the original comment
and the full conversation. Is the suggestion sound? Does it
improve the code, or is it a style preference?

**Evaluate on merits**: Don't accept feedback just because
a reviewer said it. Consider whether the change actually
improves the code or adds complexity for marginal benefit.

**Check conversation state**: If the user already replied
with good reasoning and the reviewer dropped it, recommend
skipping. Don't re-open settled conversations.

**Priority**: CHANGES_REQUESTED threads are required.
COMMENTED and APPROVED threads are optional; be selective.

**Outdated**: Code has changed since the comment. May still
be relevant, or may have been addressed by other changes.

## Recommending TDD vs Direct

Recommend TDD when:
- The change involves new testable behaviour.
- Refactoring existing logic (tests as safety net).
- The reviewer asks for a design change.

Recommend direct implementation when:
- Simple fixes (typos, naming, formatting).
- Adding documentation or comments.
- One-line fixes.

## Writing Replies

Reply text should be:
- Conversational, not formal.
- Acknowledge the feedback explicitly.
- Briefly explain what was done.
- Include commit SHAs inline (not as a list).

Good: "Extracted the validation logic as suggested. abc1234"
Bad: "Done.\n\nCommits:\n- abc1234"

## TDD Coordination

When implementing with TDD:

1. Call `pr_reply(action: "implement", use_tdd: true)`.
2. Start TDD with `tdd_phase(action: "start")`.
3. Go through red-green-refactor cycles.
4. When TDD signals done, commits are automatically tracked.
5. Call `pr_reply(action: "done", reply_body: "...")`.

## Error Recovery

If a reply fails to post, retry with the same text.
If tests fail during implementation, fix before calling
`done`. The thread stays in "implementing" state.
