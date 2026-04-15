---
name: code-tdd-guide
description: >
  Test-driven development methodology. Red-green-refactor cycle,
  when to stub, how to validate failure reasons, commit cadence.
  Use when implementing features with tests or discussing testing.
---

# Test-Driven Development

## The Cycle

### 1. Red: Write a Failing Test

Write a test that describes the behaviour you want. Run it. It
must fail, and the failure needs to be because the functionality
doesn't exist yet, not because of a syntax error, missing import
or broken test infrastructure.

**Validate the failure reason.** If the test fails for the wrong
reason (e.g., `TypeError: X is not a function`), stub out just
enough skeleton code to get a real failure:

- Create the class/module/function with an empty or minimal body.
- Return null, undefined or a zero value.
- Re-run; the test should now fail on an assertion, not an error.

### 2. Green: Make It Pass

Write the minimum code to make the test pass. No more.

- Don't anticipate future needs.
- Don't add code for cases that aren't tested yet.
- Don't optimize; just make it work.

Run the tests. They must pass.

### 3. Refactor

With green tests as your safety net, it's time to improve
the design. Call `tdd_refactor` with your suggestions: only
real refactoring opportunities, not "skip" or "no changes"
options. The tool has its own Done page for that.

The tool presents a tabbed review where the user can approve,
reject or add their own. Apply what gets approved, run tests,
then call `tdd_refactor` again with new suggestions (or empty
if you don't see anything more). Keep looping until the user
selects nothing. Only then signal `done`.

## Test Ordering

Order tests so each one forces exactly **one new increment**
of functionality into existence. The first test should need
the least code to pass. Each subsequent test should require
one new capability that the existing code doesn't have yet.

This usually means the simplest, most degenerate cases come
first (nil input, empty collection, missing resource) because
they force the minimum viable skeleton: a constructor, a
method signature, a return type. The happy path — the primary
success case — often comes **later** because it requires the
most machinery to work.

**Do not follow the plan's scenario grouping as the
implementation order.** Plans group scenarios by category
(happy path, edge cases, errors) for coverage clarity.
That grouping is not a sequence. Before writing the first
test, sort the scenarios by how much code each one forces
into existence and start with the one that forces the
least.

The test: for each scenario, ask "how much code do I need
to make this pass?" If the answer is "almost everything",
it comes later. If the answer is "a constructor and a
zero-value return", it comes first.

## After Refactor: Commit

Each red-green-refactor cycle produces one atomic commit. The
test and implementation go together because they're one unit
of work.

## Test Discovery

Figure out how to run tests from the project's context:

- Check AGENTS.md or project documentation.
- Look at package.json scripts, Makefile, Cargo.toml, etc.
- Look at existing test files for patterns and conventions.
- If unclear, ask the user.

## Test File Conventions

Infer what counts as a test file from the project:

- Files matching `*test*`, `*spec*`, `*_test.*`
- Directories named `__tests__/`, `tests/`, `test/`, `spec/`
- Follow whatever convention the project already uses.

If you can't determine the convention, ask.

## TDD Phase Tool

The `tdd_phase` tool tracks the red-green-refactor cycle.
Call it to signal phase transitions so the status display and
enforcement stay in sync with what you're doing.

### When to Signal

- **start**: when the user wants TDD or a plan specifies it.
  Confirm with the user before activating. Describe the first
  test in the `context` parameter.
- **red**: at the start of each new test within an active TDD
  session. Describe what specific behaviour is being tested in
  the `context` parameter.
- **green**: when the test fails for the right reason (an
  assertion failure, not a syntax or import error). You are
  now clear to write implementation.
- **refactor**: when tests pass with minimum implementation.
  Restructure for clarity without changing behaviour.
- **done**: when refactoring is complete. This advances to the
  next cycle. If you know the next test, describe it in
  `context`.
- **stop**: when the user redirects away from TDD or when
  all planned tests are complete.

### Summary Parameter

Every phase transition (except `start`) shows a confirmation
gate to the user. Always provide a `summary` describing what
you accomplished in the current phase. Be specific:

- **red → green**: Include the test failure output: the
  assertion message and what it expected vs. got. The user
  needs to see that the test fails for the right reason.
- **green → refactor**: Include the test pass confirmation
  and a brief note on what implementation was added.
- **refactor → done**: Describe what was cleaned up.
- **stop**: Summarize where things stand.

### One Test at a Time

Focus on a single test per cycle. Even if you can see multiple
tests that need writing, describe and implement one at a time.
The `context` parameter should name the specific behaviour
under test; it's displayed to the user so they know what
you're working on.

### Leaving TDD

If the user steers you toward something outside the TDD cycle
(e.g., "fix that config file", "let's look at something else"),
call `tdd_phase` with action `stop` before proceeding. Do not
leave TDD mode silently.

### Manual Override

The `/tdd` command and `Ctrl+Alt+T` shortcut also toggle TDD
mode directly.
