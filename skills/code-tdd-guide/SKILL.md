---
name: code-tdd-guide
description: >
  Test-driven development methodology. Red-green-refactor
  cycle, when to stub, how to validate failure reasons,
  commit cadence. Use when implementing with TDD, writing
  tests first or driving the tdd_loop tool.
---

# Test-Driven Development

TDD is a design discipline, not a testing chore. You write the
test first because the test is where you decide what the code
looks like from the outside, before any implementation can talk
you out of a clean shape. The tests you keep are a description
of intent and a description of the exported interface, and
nothing more than that.

## What the Tests Are For

Hold these in mind through every loop. They are why the cycle
is shaped the way it is.

- **Tests drive the design.** Writing the test first makes you
  use the interface before it exists, so you feel its shape
  from the caller's side. When calling it is awkward, the
  design is wrong, so you fix the design, not the test.
- **Tests reflect intent.** Each test names a behaviour you
  want, in the language of the domain. A reader should be able
  to learn what the code is for by reading its tests.
- **Tests bind to the exported surface only.** Test the public
  interface, never the internals. A test that reaches into
  private structure freezes an implementation detail and breaks
  during refactors that should not concern it. If something
  internal feels like it needs its own test, that is a sign it
  wants to be its own unit with its own exported surface.
- **Friction is a signal.** When a test is hard to write, with
  heavy setup, awkward mocking or contortions to observe a
  result, the design is telling you something. Step back and
  reshape the interface before you push through.
- **Growth follows real needs.** Add code only when a test that
  reflects a real consumer need demands it. Do not build for
  futures you imagine. Build for the increment in front of you.

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

With green tests as your safety net, improve the design. This is
the moment to step back and reconsider both the internal shape
and the exported interface, now that a real consumer need exists
and a passing test proves the behaviour. Restructure for
clarity; keep the behaviour, and keep the tests green. Do the
refactoring with your normal editing tools.

When you're satisfied, close the loop with a one-line reflection
on what you reconsidered.

## Test Ordering

Order tests so each one forces exactly **one new increment**
of functionality into existence. The first test should need
the least code to pass. Each subsequent test should require
one new capability that the existing code doesn't have yet.

This usually means the simplest, most degenerate cases come
first (nil input, empty collection, missing resource) because
they force the minimum viable skeleton: a constructor, a
method signature, a return type. The happy path, the primary
success case, often comes **later** because it requires the
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

## Closing the Loop: Commit

Each red-green-refactor loop produces one atomic commit. The
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

## The tdd_loop Tool

The `tdd_loop` tool tracks one red-green-refactor loop at a
time. It is a tracker and a reminder, not a gate. It never
interrupts the user and it never blocks your file writes. You
drive it, and the only human-facing surface is a small glyph and
the phase name on the status line.

Run **one loop per increment**. Open a loop when you're ready
for the next single behaviour, take it through to green and
refactor, then close it before you open the next. Keep each loop
to one behaviour rather than batching several together.

Each transition carries a short justification: a phrase, an
assertion line, a one-line reflection. The machine advances only
when that justification is present and the move makes sense from
where the loop is. Otherwise it hands back a line of guidance
and changes nothing. There's no prompt to answer; read the
guidance, do what it names and try the transition again.

### The Transitions

The classic three steps expand into the tool's transitions. Red
becomes `plan`, `write` and `red`; the loop then closes with
`done` after `refactor`. Every loop passes through `refactor` to
reach `done`, even as a no-op when there's nothing to change.

- **plan** (`behaviour`): what the code should do, in one
  phrase, named after the symbol you wish existed. Opens the
  loop into the `plan` phase.
- **write** (`interface`): the exact exported surface the test
  imports and calls. Bind the test to the public interface,
  never the internals.
- **red** (`failure`, `failureKind`): the failure you saw when
  you ran the test. A compile or missing-symbol error is
  `failureKind: "other"` and is not a real red, so stub a
  minimal skeleton, re-run, and call `red` again with the
  assertion failure (`failureKind: "assertion"`). Only a
  verified assertion red clears the way to green.
- **green** (`pass`): the passing result you saw. Write the
  minimum code to pass. Do not touch the test to make it green.
- **refactor**: no justification needed. Improve the design with
  the tests staying green. Required on the way to `done`.
- **done** (`reflection`): a one-line note on what you
  reconsidered about the internal and external design. Closes
  the loop and returns to rest.
- **abandon** (`reason`): leave the loop early. Use this when
  the user steers you elsewhere, or when a loop can't be
  satisfied; don't leave one dangling silently.

### Attest Red Honestly

Attest red honestly. The whole value of red is proving the test
fails for the reason you think. A `TypeError` or a missing
symbol is not that proof; it is `failureKind: "other"`. When you
hit one, stub just enough skeleton to get a real assertion
failure, then attest the real red with `failureKind:
"assertion"`. The tool records the kind you report; it never
reads your test output, so report it straight.
