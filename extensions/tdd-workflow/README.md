# TDD Workflow Extension

A tracker and a reminder for test-driven development, not a
turnstile.

The [code-tdd-guide skill](../../skills/code-tdd-guide/) teaches
the methodology and tells the agent how to drive the loop. This
extension keeps the loop's state, shows it on a glyph scoreboard
and reminds the agent of the standing discipline for each phase.
It interprets nothing about the outside world: it never reads
code, test output or file paths, and it never blocks a write.

## How It Works

The agent drives one discrete red-green-refactor loop at a time
through the `tdd_phase` tool, attesting each transition with a
short justification. The machine advances only when the
attestation carries what the step requires, and otherwise hands
back a line of guidance and changes nothing. There are no user
prompts: the only human-facing surface is the passive scoreboard.

On a clean transition the extension advances the loop, persists
it to session history, repaints the scoreboard and returns the
next phase's discipline to the agent. On a refused transition it
returns the guidance and leaves the loop untouched.

### The Loop

| Action | Justification | Meaning |
|---|---|---|
| `start` | `behaviour` | Open a loop on one behaviour |
| `write` | `interface` | Author the test against the exported surface |
| `red` | `failure`, `failureKind` | Attest the failure you saw |
| `green` | `pass` | Minimum code, test passes |
| `refactor` | (none) | Improve the design, tests green |
| `done` | `reflection` | Close the loop with a design reflection |
| `abandon` | `reason` | Leave the loop early |

A `red` whose `failureKind` is `other` (a compile or
missing-symbol error) is not a verified red. The agent stubs a
skeleton and re-attests `red` with an `assertion` failure before
`green` will open.

### The Only Guardrail

The extension enforces the agent's own contract, never the
world. Gating on attested justifications is the one guardrail
that stays robust across every language, because it never has to
parse a test runner, sniff a path or recognize a symbol. There
is no GREEN write-block and no language-specific heuristic.

## Status Display

The status line shows a phase-coloured glyph; while a loop is
running, a widget shows the glyph next to the behaviour under
test. The glyph fills as the test materializes and changes shape
as the loop advances, so the state stays legible without colour:

| State | Glyph | Colour |
|---|---|---|
| Idle | `◌` | dim |
| Plan (started) | `○` | yellow |
| Write | `◐` | yellow |
| Red, unverified | `◐` | red |
| Red, verified | `●` | red |
| Green | `✓` | green |
| Refactor | `◆` | blue |

The loop survives a `/reload`: it persists to session history
and restores on session start.
