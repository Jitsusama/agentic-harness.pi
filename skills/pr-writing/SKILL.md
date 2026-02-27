---
name: pr-writing
description: >
  Pull request structure, narrative, and review guidance. Use when
  creating pull requests, writing PR descriptions, or discussing
  what makes a good PR.
---

# Pull Request Writing

A PR has three layers: the code changes (reviewers can see
these), the technical decisions (you must explain these), and
the business impact (you must connect to this). Your job is to
build bridges from the inner layer to the outer one.

## Title

- Use Title Case — not `feat(auth): add refresh` style
- Describe the value, not the implementation
- 50–72 characters
- Formula: `[Action] [What] [For What Purpose]`

Good: "Add Token Refresh to Prevent Session Timeouts"
Bad: "feat(auth): implement refresh token logic"

## Body Structure

### What We're Doing

One paragraph connecting the change to the problem it solves.
Link to issues or references.

### Why This Matters

The "so what" — why should anyone care? State the impact:
"Without this, [specific bad thing] happens, causing
[measurable consequence]."

### Review Focus

2–3 specific areas where review matters most. For each:
what to look at, what could go wrong, and why it matters.

### Technical Approach

Key decisions and trade-offs only — not implementation
details visible in the diff. "Chose A over B because C
matters more than D for this use case."

## Story Types

Recognize what kind of story the changes tell:

- **Performance** — lead with the metrics that were bad
- **Reliability** — lead with the failure scenarios
- **Security** — lead with the risk or compliance need
- **Feature** — lead with the user problem being solved

## The Three Questions

Every PR must answer:

1. What problem does this solve?
2. Why this approach over alternatives?
3. What could go wrong?

## Quality Checks

Before submitting:

- Would a non-technical stakeholder understand the value?
- Would a new team member know what to review carefully?
- Would a senior engineer understand the trade-offs?
- Is every claim backed by real data, not assumptions?

## What Not to Do

- Don't list what changed — that's visible in the diff
- Don't use generic phrases like "improves performance"
- Don't skip the "why" and jump to the "what"
- Don't leave the review focus empty or vague
