---
name: planning-guide
description: >
  The single planning skill: how to plan collaboratively and how
  to structure the living plan document. Covers the staged plan
  workflow (think, draft, build), debating before deciding, the
  front-matter contract, the recommended sections, checkbox
  progress and deviation. Use when planning, designing before
  building, driving the plan tool, or writing a plan file. Works
  for code, investigation, writing and ops plans alike. Follow
  the user's prose standard for any text in the plan.
---

# Planning

Planning is where you think a problem through and debate it
before touching code. It is a conversation, not an intake form.
You dig hard, you argue for the best shape, and you leave with a
living document that captures the spirit of the work and tracks
its own progress.

The `plan` tool drives the workflow. The plan document is the
single source of truth: it survives reloads, resumes and cold
starts, and the workflow rehydrates from it. The tool is a
tracker, not a gate. It never prompts the user; it only reflects
where the work is and reminds you of the posture for each stage.

## The Stages

A plan moves through three working stages and two terminal ones.

- **think** (read-only): dig and debate. No implementing.
- **plan** (read-only except the plan document): draft the
  document.
- **build** (writes allowed): implement against the plan.
- **concluded** / **retired**: terminal. The document is the
  record.

You drive transitions with the `plan` tool:

- `think` opens a plan from idle, with a `note` on what it is
  about. It also reopens a plan from `plan` or `build` when
  discovery sends you back to the drawing board (replan).
- `draft` moves think to plan and creates the document, with a
  `title` that becomes its H1.
- `build` moves plan to build once the document is drafted.
- `conclude` closes a finished plan; `retire` abandons one with
  a `reason`.

A refused transition hands back guidance and changes nothing.
There is no approval prompt.

## Think: Dig, Then Debate

Investigate before you form a view. Read the code, trace the
flow, understand the current state. Only once you have dug should
you start shaping an approach.

Then debate. Surface tradeoffs. Float alternatives and say which
you prefer and why. Push back where you disagree. Work the
problem high level first, because a change up top invalidates the
detail below it. Take one thread at a time rather than a wall of
parallel points.

Ask the user only when something genuinely blocks you, and ask in
plain conversation, one question at a time. There is no interview
tool and no batch of questions. If you are explaining, analyzing
or proposing, that is conversation, not a question.

## The Plan Document

The document is what you carry out of planning. Aim for a proper
markdown file that reads well on its own, with just enough
structure that the workflow can parse it.

### The parsed contract

Only two things are ever parsed, so only two things are load
bearing. Everything else is your prose.

1. **Front-matter**: a small YAML block at the top.

```yaml
---
id: PLAN-20260530-a3f
stage: build
updated: 2026-05-31
sessions:
  - 019e7a4b-516e-7911-a1ff-6d5383f7fa64
---
```

The `id` is stable and assigned once; the H1 is the friendly
name and can change freely. `stage`, `updated` and `sessions`
are maintained by the workflow as you transition, so you rarely
touch them by hand.

2. **Checkboxes**: standard GitHub task-list items (`- [ ]` and
   `- [x]`) anywhere in the body. These are the progress.

### Recommended sections

These are a starting shape, not a cage. Reshape them to fit the
work; the parser never reads section headings.

```markdown
# A Readable Title

## Spirit
The stable north star: why this work exists and what good looks
like. This is the part that must survive every deviation.

## Context
What framing the problem surfaced. Constraints. What is in and
out of scope.

## Approach
The shape you settled on and the decisions behind it, each with
its rationale.

## Work
- [ ] First increment, sequenced so each step forces the least
- [ ] Next increment

## Open Questions
- [ ] Anything still unresolved

## Discovery & Deviations
An append-only, dated log. When the work surfaces something that
changes the plan, it lands here with the decision and the consent
behind it.
```

## Progress and Keeping It Current

The document must always reflect reality, because the work may
resume in a different session days later. While building, check
off `- [ ]` to `- [x]` as you finish each increment, and write
what you discover into Discovery & Deviations. Updating the
document is not bookkeeping you do at the end; it is how the
workflow knows where the work stands.

When resuming, trust the checkboxes: the checked items are done,
the unchecked are what remain.

## Deviating From the Plan

When build surfaces something the plan did not foresee, the
response depends on what changes.

- A change to the **spirit or the approach** needs the user's
  consent. Stop, explain what you found and what you would
  change, and get their agreement before proceeding.
- Anything **smaller**, you just do, and record it in Discovery &
  Deviations so the document stays honest.

If the plan is genuinely wrong, reopen it: transition back to
`think` with a note on what changed, rework the approach, then
redraft.

## Where Plans Live

The workflow writes the document to a durable location anchored
to the main worktree root, so a plan started inside a linked
worktree does not vanish when that worktree is removed. A
personal setup can route plans into its own home by registering
a router (see the plan-routing library); the package default is
just the fallback.

## Granularity

Size each Work item so it is:

- Small enough for one increment or one commit.
- Independently verifiable.
- Clear enough that someone reading only that line knows what to
  do.

## For Code Plans

A plan gives context and direction, not implementation. It
explains what to build and why; the how is decided while
building, under TDD. So a code plan is most useful when it
captures:

- **Skills to follow**: name them rather than restating them
  (for example `code-tdd-guide`, `code-style-standard`, the
  prose standard). The implementer loads them.
- **Interfaces**: the exported surface and how it is called,
  with signatures and what it returns.
- **Data shapes**: what flows through the system and why it is
  shaped that way.
- **Test scenarios**: a flat coverage checklist of behaviours to
  verify, not full test code and not a TDD order. More scenarios
  emerge while building.

Keep complete implementation code, complete test code and
step-by-step procedures out of the plan. If you are writing the
body of a method, you have stopped planning and started coding.
