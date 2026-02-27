---
name: planning
description: >
  Collaborative planning methodology. How to investigate a codebase,
  ask clarifying questions, and produce a structured implementation
  plan. Use when designing or architecting before building.
---

# Collaborative Planning

## Flow

1. **Understand the goal** — what are we trying to accomplish and why
2. **Investigate** — read the relevant code, understand the current state
3. **Ask questions** — use the questionnaire tool for structured input,
   or ask through conversation for open-ended discussion
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

## Using Plan Mode

The `/plan` command activates read-only enforcement — the agent
cannot modify files until you transition out. Use it when you want
the guardrail that investigation stays investigation.

Without `/plan`, this skill still guides behavior — the agent
investigates and collaborates before proposing changes.
