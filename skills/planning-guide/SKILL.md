---
name: planning-guide
description: >
  Collaborative planning methodology. How to investigate a codebase,
  ask clarifying questions and produce a structured implementation
  plan. Use when designing or architecting before building.
---

# Collaborative Planning

## Flow

1. **Understand the goal**: what are we trying to accomplish and why.
2. **Investigate**: read the relevant code, understand the current state.
3. **Ask questions**: use `plan_interview` when you have
   genuine questions that need the user's input. Loop until
   you have no more and the user adds none.
4. **Summarize findings**: present what you learned, concisely.
5. **Propose an approach**: high-level strategy, invite feedback.
6. **Iterate**: refine through conversation until aligned.
7. **Write the plan**: structured markdown file.
   - **If planning code work:** Load the `planning-dev-format` skill for
     guidance on plan structure (interfaces, data flow, test scenarios).

## Interview vs. Conversation

`plan_interview` is for **questions that need the user's
input** — decisions, preferences, scope calls, trade-off
choices. If you're presenting analysis, explaining findings,
summarizing what you learned, or proposing an approach, that's
**conversation** — write it as a normal response.

The test: if the user could meaningfully skip the item or
pass on it, it's a question. If they'd be confused by a
"Pass" button because you're explaining something to them,
it's conversation.

## Plan File Naming

Name plan files with a condensed ISO 8601 date prefix
followed by a short, descriptive slug:

```
YYYYMMDD-descriptive-slug.md
```

Examples:
- `20260329-slack-pagination.md`
- `20260329-plan-conventions.md`

The date prefix ensures plans sort chronologically in a
directory listing. The slug should be specific enough to
identify the plan at a glance without opening it.

## Plan File Format

```markdown
## Goal

What we're trying to accomplish and why.

## Skills to Follow

Reference skills the implementer should load (for dev plans).

## Context

Relevant existing code, architecture, constraints discovered
during investigation.

## Approach

High-level strategy. Why this approach over alternatives.

## Steps

- [ ] First step: small enough for one TDD cycle / one commit.
- [ ] Second step.
- [ ] ...

## Open Questions

Anything unresolved that might affect implementation.

## Risks

Known risks and how we'll mitigate them.
```

For dev plans, the "Skills to Follow" section names the skills
the implementer should load (e.g., `code-tdd-guide`,
`code-style-standard`, `prose-standard`). See `planning-dev-format`
for the full list and structure.

## Step Granularity

Each step should be:
- Small enough for one TDD cycle (one test + implementation).
- Small enough for one atomic commit.
- Independently verifiable; you can run tests after each step.
- Clearly described; someone reading just the step knows what to do.

## Progress Tracking

Plans are living documents. Use checkboxes (`- [ ]` / `- [x]`)
for steps so the implementer can mark them off as they go.
After completing a step, update the plan file before moving
on to the next one. This keeps the plan accurate and makes it
easy to resume after interruptions.

## Deviating from the Plan

When the implementer discovers that the plan needs to change
(a step doesn't make sense any more, the order should shift,
a new step is needed, or the approach itself is wrong), they
must stop and communicate with the user before proceeding.
Explain what changed, why the plan no longer fits and what
you'd propose instead. Don't silently deviate; get buy-in
first, then update the plan to reflect the new direction.

## Plan Mode Tool

The `plan_mode` tool activates read-only enforcement: you
can't modify files outside the plan directory until plan mode
is deactivated.

When the user's intent suggests investigation or planning
(e.g., "let's plan this", "I want to understand the codebase
first", "let's think about this before building"):

1. Confirm with the user that they want plan mode.
2. Identify which repositories the work will touch.
3. Call `plan_mode` with action `activate` and the `repos`
   parameter listing those paths (use `"."` for the current
   repo). This creates a worktree in each repository so
   implementation happens in isolated working trees.
4. Investigate, collaborate, write the plan.
5. When the plan is written, a transition gate appears.
   Choosing to implement deactivates plan mode. The
   implementation prompt includes the worktree paths;
   cd into each worktree to implement.

Worktrees are created at each repo's current HEAD. Branch
creation happens later, during implementation, following
the `git-branch-convention` skill.

When worktree isolation isn't needed (quick investigations,
plans that won't lead to implementation), omit the `repos`
parameter. Plan mode will activate without worktrees.

The `/plan` command and `Ctrl+Alt+P` shortcut also toggle
plan mode directly (without worktrees).
