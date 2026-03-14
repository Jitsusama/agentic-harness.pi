---
name: pr-reply
description: >
  Responding to GitHub PR review feedback. Workflow for analyzing
  review threads, implementing changes, and posting replies with
  commit references. Use when addressing PR reviews or responding
  to reviewer feedback.
---

# PR Reply Workflow

## When to Use

Use pr-reply mode when a PR has review feedback to address:

- Reviewer left comments or requested changes
- Multiple threads across different files
- Mix of required changes and optional suggestions
- Need to track which threads have been addressed

## How It Works

The `pr_reply` tool manages the workflow through a series of
actions. You drive the conversation — the tool provides data
and tracks state.

### Step 1: Activate

Call `pr_reply` with action `activate` and a PR reference.

```
pr_reply(action: "activate", pr: "https://github.com/owner/repo/pull/123")
```

The tool fetches all reviews and threads, filters out resolved
and dismissed ones, and returns a summary. It also shows the
user a summary panel.

### Step 2: Review Overview

Call `pr_reply` with action `next`. When you encounter a new
reviewer, the tool returns review-level data (author, state,
body, thread list).

Analyze the review's character — is it thorough, nitpicky,
collaborative, blocking? Then present it:

```
pr_reply(action: "review", analysis: "Collaborative review with one structural suggestion and several style observations. No blockers.")
```

The tool shows the review overview to the user. They can
continue or skip the entire review.

### Step 3: Iterate Threads

After the review is acknowledged, call `next` again. Now it
returns thread data (conversation, code context, metadata).

Analyze the thread, then present it:

```
pr_reply(action: "show", analysis: "The reviewer wants guard clauses. You already agreed and implemented this. **Recommend: Skip** — already handled.")
```

The `show` action presents two tabs:
- **Action** — original comment, code context, your analysis, action options
- **Thread** — full conversation history (read-only)

Your analysis should include:
- Summary of the feedback
- Assessment of the conversation state
- Your recommendation (implement, reply, skip, defer)
- Why you recommend that

### Step 3: Take Action

Based on the user's decision:

**Implement** (code changes needed):
```
pr_reply(action: "implement", use_tdd: true)
```
The tool records the current HEAD and marks the thread as
implementing. Then:
- If `use_tdd: true` — start TDD mode with `tdd_phase`
- If `use_tdd: false` — make changes directly

After changes are committed, call `done`:
```
pr_reply(action: "done", reply_body: "Extracted the validation logic as suggested. abc1234")
```

**Reply** (no code changes):
```
pr_reply(action: "reply", reply_body: "Good point — I'll address this in a follow-up PR.")
```

**Skip** (ignore this thread):
```
pr_reply(action: "skip")
```

**Defer** (handle later this session):
```
pr_reply(action: "defer")
```

### Step 4: Continue

After each action, call `next` again to get the next thread.
Repeat until all threads are addressed.

### Step 5: Deactivate

When all threads are done (or you want to stop):
```
pr_reply(action: "deactivate")
```

The tool reports what was accomplished and checks for
dependent PRs that may need rebasing.

## Analyzing Threads

Your job is to think critically, not to agree with the
reviewer by default. The user trusts your judgment — give
them a real opinion, not a summary of what happened.

When you receive thread data from `next`, analyze:

**What they're actually asking**: Read the original comment
and the full conversation. Is the suggestion sound? Does it
improve the code, or is it a style preference? Would the
change introduce complexity for marginal benefit?

**Evaluate the suggestion on its merits**: Don't just accept
feedback because a reviewer said it. Consider:
- Does the rename/refactor actually improve clarity?
- Is the concern valid for this code, or theoretical?
- Does the user's existing reply already address it?
- Is this worth changing, or is the current code fine?

**Check conversation state**: If the user already replied
with their reasoning — and the reviewer accepted it or
dropped it — recommend skipping. Don't re-open settled
conversations. If the user pushed back and the reviewer
insisted, that's different.

**Code context**: Look at the surrounding code. Does the
suggestion make sense in context? Sometimes a reviewer
comments on one line without seeing the bigger picture.

**Plan context**: If there's a plan in `.pi/plans/` related
to this PR's issue, consider whether the feedback aligns
with or contradicts the planned direction.

**Priority**: CHANGES_REQUESTED threads are required.
COMMENTED and APPROVED threads are optional — be more
selective about which optional threads are worth acting on.

**Outdated**: If the comment is marked outdated, the code
has changed since the comment was made. It may still be
relevant — or it may have been addressed by other changes.

**Already addressed**: If the conversation shows the user
already agreed and made the change (check for replies
mentioning commits, or "done", "fixed", etc.), recommend
skipping — it's already handled.

## Recommending TDD vs Direct

Recommend TDD when:
- The change involves new behavior that can be tested
- Refactoring existing logic (tests as safety net)
- The reviewer is asking for a design change

Recommend direct implementation when:
- Simple fixes (typos, naming, formatting)
- Adding documentation or comments
- Configuration changes
- One-line fixes

## Writing Replies

Reply text should be:
- Conversational, not formal
- Acknowledge the feedback explicitly
- Briefly explain what was done
- Include commit SHAs inline (not as a list)

Good:
```
Extracted the validation logic to a separate module as
suggested. Also added async support per your follow-up
comment. abc1234 def5678
```

Bad:
```
Done.

Commits:
- abc1234
- def5678
```

If replying without code changes:
- Ask clarifying questions if needed
- Explain your reasoning if deferring or disagreeing
- Acknowledge informational comments

## TDD Coordination

When implementing with TDD:

1. Call `pr_reply(action: "implement", use_tdd: true)`
2. Start TDD with `tdd_phase(action: "start")`
3. Go through red-green-refactor cycles
4. When TDD signals done, commits are automatically tracked
5. Call `pr_reply(action: "done", reply_body: "...")` to
   post the reply

The pr-reply extension listens for TDD completion events
and links commits automatically.

## Deferred Threads

When all threads have been reviewed, if some were deferred,
the `next` action will tell you. Options:

- Reset deferred threads to pending and iterate again
- Deactivate and handle them later
- Skip them all

Deferred state persists within the pi session.

## Stack Rebasing

When deactivating, if changes were made and other PRs depend
on this branch, the tool reports them. Suggest rebasing
using git operations.

## Error Recovery

If a reply fails to post, the tool returns the error.
Retry by calling `reply` again with the same text.

If tests fail during implementation, fix the issue before
calling `done`. The thread stays in "implementing" state.

If TDD exits unexpectedly, the thread stays in "implementing".
Call `done` when ready, or `skip` to move on.
