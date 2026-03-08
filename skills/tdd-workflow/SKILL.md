---
name: tdd-workflow
description: >
  Test-driven development methodology. Red-green-refactor cycle,
  when to stub, how to validate failure reasons, commit cadence.
  Use when implementing features with tests or discussing testing.
---

# Test-Driven Development

## The Cycle

### 1. Red — Write a Failing Test

Write a test that describes the desired behavior. Run it. It must
fail. The failure must be because the functionality doesn't exist
yet — not because of a syntax error, missing import, or broken
test infrastructure.

**Validate the failure reason.** If the test fails for the wrong
reason (e.g., `TypeError: X is not a function`), stub out just
enough skeleton code to get a "real" failure:

- Create the class/module/function with an empty or minimal body
- Return null, undefined, or a zero value
- Re-run — the test should now fail on an assertion, not an error

### 2. Green — Make It Pass

Write the minimum code to make the test pass. No more.

- Don't anticipate future needs
- Don't add code for cases that aren't tested yet
- Don't optimize — just make it work

Run the tests. They must pass.

### 3. Refactor

With green tests as your safety net, improve the design:

- Rename for clarity
- Extract functions or modules
- Simplify logic
- Remove duplication
- Improve types

Run tests after each change. If anything breaks, undo and try a
smaller refactor.

## Test Ordering

Within a test file, order tests from most expected to least
expected behavior:

1. **Happy path** — the primary success case
2. **Alternate outcomes** — other valid paths through the code
   (e.g., empty results, failed upstream query — these are
   expected scenarios with different outcomes, not errors)
3. **Edge cases** — boundary conditions, zero/one/many, nil
4. **Error cases** — invalid inputs, unsupported types,
   exceptions that indicate a bug or misconfiguration

When adding a new test in a later TDD cycle, place it in the
right position according to this ordering — not just appended
to the end.

## After Refactor: Commit

Each red-green-refactor cycle produces one atomic commit. The test
and implementation go together — they're one unit of work.

## Test Discovery

Figure out how to run tests from project context:

- Check AGENTS.md or project documentation
- Look at package.json scripts, Makefile, Cargo.toml, etc.
- Look at existing test files for patterns and conventions
- If unclear, ask the user

## Test File Conventions

Infer what counts as a test file from the project:

- Files matching `*test*`, `*spec*`, `*_test.*`
- Directories named `__tests__/`, `tests/`, `test/`, `spec/`
- Follow whatever convention the project already uses

If you can't determine the convention, ask.

## Using TDD Mode

The `/tdd` command activates phase enforcement — the extension
tracks whether you're in red, green, or refactor phase and
enforces the discipline. Includes an explicit refactor gate
where the user decides when to move on.

Without `/tdd`, this skill still guides behavior — follow the
cycle voluntarily.
