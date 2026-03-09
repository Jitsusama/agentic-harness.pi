---
name: plan-workflow
description: >
  Collaborative planning methodology. How to investigate a codebase,
  ask clarifying questions, and produce a structured implementation
  plan. Use when designing or architecting before building.
---

# Collaborative Planning

## Flow

1. **Understand the goal** — what are we trying to accomplish and why
2. **Investigate** — read the relevant code, understand the current state
3. **Ask questions** — use `plan_interview` for structured input.
   Loop: present questions, process answers, ask follow-ups.
   Keep going until you have no more questions and the user
   adds none.
4. **Summarize findings** — present what you learned, concisely
5. **Propose an approach** — high-level strategy, invite feedback
6. **Iterate** — refine through conversation until aligned
7. **Write the plan** — structured markdown file

## Plan File Format

```markdown
## Goal

What we're trying to accomplish and why.

## Context

Relevant existing code, architecture, constraints discovered
during investigation.

## Approach

High-level strategy. Why this approach over alternatives.

## Steps

1. First step — small enough for one TDD cycle / one commit
2. Second step
3. ...

## Open Questions

Anything unresolved that might affect implementation.

## Risks

Known risks and how we'll mitigate them.
```

## Step Granularity

Each step should be:
- Small enough for one TDD cycle (one test + implementation)
- Small enough for one atomic commit
- Independently verifiable — you can run tests after each step
- Clearly described — someone reading just the step knows what to do

## Plan Mode Tool

The `plan_mode` tool activates read-only enforcement — you
cannot modify files outside the plan directory until plan mode
is deactivated.

When the user's intent suggests investigation or planning
(e.g., "let's plan this", "I want to understand the codebase
first", "let's think about this before building"):

1. Confirm with the user that they want plan mode
2. Call `plan_mode` with action `activate`
3. Investigate, collaborate, write the plan
4. When transitioning to implementation, call `plan_mode`
   with action `deactivate`

The `/plan` command and `Ctrl+Alt+P` shortcut also toggle
plan mode directly.
