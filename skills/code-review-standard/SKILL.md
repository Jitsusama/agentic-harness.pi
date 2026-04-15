---
name: code-review-standard
description: >
  Evaluation criteria for code review: test quality,
  implementation quality, naming, consistency, scope and PR
  descriptions. Use when reviewing code or a pull request.
  Pairs with comment-format for review comment structure.
---

# Code Review Criteria

## Test Evaluation

### Behaviour vs Implementation

Tests should verify **what the code does**, not **how it
does it**. Some red flags to watch for:

- Asserting on internal state or private methods
- Mocking every dependency instead of testing integration
- Tests that break when implementation changes without
  behaviour change
- Test names that describe implementation steps

Good tests describe a behaviour: "returns error when input is
empty", "retries on transient failure", "caches result for
subsequent calls."

### Idiom

Tests should follow the project's existing patterns. Look
for:

- Consistent test framework usage (describe/it, test, etc.)
- Shared setup patterns (fixtures, factories, beforeEach)
- Assertion style consistency
- Naming conventions for test files and descriptions

### Structure

- Is each test focused on one behaviour?
- Are test descriptions readable as documentation?
- Is setup proportional to what's being tested?
- Are edge cases covered (null, empty, boundary values)?

### Coverage Gaps

For new code:
- Is every public function or method exercised?
- Are error paths tested, not just happy paths?
- Are integration points tested (API calls, DB queries)?
- For bug fixes: is there a test that fails without the fix?

## Implementation Evaluation

### Readability

Code is read far more often than it's written. Check:

- Can you understand the intent without reading comments?
- Are functions short enough to hold in your head?
- Is the control flow straightforward?
- Are there unnecessary abstractions or indirection?

### Abstraction Level

- Is the abstraction level consistent within a function?
- Are there leaky abstractions (implementation details
  leaking through interfaces)?
- Could simpler code achieve the same result?
- Is complexity justified by the problem?

### Domain Naming

Names should come from the problem domain rather than the
implementation domain:

- Bad: `processData`, `handleStuff`, `doThing`
- Good: `validateOrder`, `resolveConflict`, `applyDiscount`
- Variables should reveal intent: `remainingAttempts` not `n`

### Composition

- Are responsibilities clearly separated?
- Could any piece be reused independently?
- Are dependencies explicit (parameters, not globals)?
- Is there duplicated logic that should be extracted?

## Consistency Evaluation

### Pattern Matching

Search the codebase for similar patterns and ask:

- Does this new code follow existing conventions?
- If it introduces a new pattern, is the old one deprecated?
- Are similar problems solved differently elsewhere? Why?
- Would a developer reading nearby code be surprised?

Use `rg` to find similar patterns:
```
rg "similar_function_name" --type ts
rg "class.*Service" --type ts
rg "export function" path/to/similar/module.ts
```

### Convention Compliance

Check project-specific conventions:
- File naming and organization
- Export patterns (default vs named)
- Error handling patterns
- Logging and observability patterns
- Configuration patterns

## Scope Evaluation

### Focus

- Does the PR do one thing well, or multiple things?
- Are there drive-by fixes mixed with the main change?
- Could this be split into independently shippable PRs?
- Does the scope match the linked issue?

### Size

Large PRs are harder to review well. Some guidelines:

- Under 200 lines: easy to review thoroughly.
- 200–500 lines: needs careful attention.
- Over 500 lines: consider whether it should be split.

Size alone doesn't determine quality though; a 400-line PR
adding a new feature with tests may be perfectly appropriate,
while a 100-line PR touching 15 files may be too scattered.

## PR Description Evaluation

### As a Historic Record

The description should answer these questions for future
readers:

1. **What problem does this solve?** (not what it changes)
2. **Why this approach?** (trade-offs considered)
3. **What could go wrong?** (risks, edge cases)

### Accuracy

- Does the title match the actual change?
- Does the description mention all significant decisions?
- Are there changes not explained in the description?
- Is anything claimed that the diff doesn't support?

## Review Priorities

Not all feedback is equally important. Here's the priority
order:

1. **Correctness**: does it work? Are there bugs?
2. **Security**: are there vulnerabilities?
3. **Architecture**: does the design make sense?
4. **Testing**: is behaviour adequately tested?
5. **Readability**: can others understand this?
6. **Style**: minor preferences (lowest priority).

## What Not to Do

- Don't review for style when the project has a linter.
- Don't request changes for personal preference.
- Don't leave vague feedback ("this feels wrong").
- Don't ignore the why and only critique the what.
- Don't forget to praise things done well.
