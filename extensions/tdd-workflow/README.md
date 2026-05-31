# TDD Workflow Extension

A tracker and a reminder for test-driven development, not a
turnstile.

The [code-tdd-guide skill](../../skills/code-tdd-guide/) teaches
the methodology and tells the agent how to drive the loop. This
extension keeps the loop's state, shows it on a glyph scoreboard
and reminds the agent of the phase discipline as each transition
lands. It interprets nothing about the outside world: it never
reads code, test output or file paths, and it never blocks a
write.

## How It Works

The agent drives one discrete red-green-refactor loop at a time
through the `tdd_loop` tool, attesting each transition with a
short justification. The machine advances only when the
attestation carries what the step requires, and otherwise hands
back a line of guidance and changes nothing. There are no user
prompts: the only human-facing surface is the passive scoreboard.

On a clean transition the extension advances the loop, persists
it to session history, repaints the scoreboard and returns the
new phase's discipline to the agent. On a refused transition it
returns the guidance and leaves the loop untouched.

Success and refusal must never be confused, because the phase
reminders and the refusal guidance deliberately share vocabulary
— the `red` reminder ("the failure has to be a real assertion…")
reads almost word-for-word like the `green` refusal ("you
haven't seen a real red yet…"). So every reply leads with a
verdict marker the agent reads first: `✓ Advanced to <phase>` on
a landed transition, `✗ Refused — still in <phase>, nothing
changed` on a refusal. The marker, not the prose, carries the
verdict; the shared discipline language can no longer mislead.

### The Loop

| Action | Justification | Meaning |
|---|---|---|
| `plan` | `behaviour` | Open a loop on one behaviour |
| `write` | `interface` | Author the test against the exported surface |
| `red` | `failure`, `failureKind` | Attest the failure you saw |
| `green` | `pass` | Minimum code, test passes |
| `refactor` | (none) | Improve the design, tests green |
| `done` | `reflection` | Close the loop with a design reflection |
| `abandon` | `reason` | Leave the loop early |

`red` requires `failureKind`. A `failureKind` of `other` (a
compile or missing-symbol error) is not a verified red: the
agent stubs a skeleton and re-attests `red` with an `assertion`
failure before `green` will open. Every loop passes through
`refactor` to reach `done`, even as a no-op.

### The Only Reminder

The extension tracks the agent's own attestation, never the
world. Keying transitions off attested justifications is the one
contract that stays robust across every language, because it
never has to parse a test runner, sniff a path or recognize a
symbol. It admits what it is: a reminder for a cooperating agent,
not a guard against a hostile one. There is no GREEN write-block
and no language-specific heuristic.

## Status Display

While a loop runs, the status line shows a constant `TDD` label
beside a phase-coloured glyph, so the line stays put from step to
step; the glyph carries the phase through its shape and colour. A
widget alongside it spells out the phase, the iteration and the
behaviour under test. Both fall silent at idle. The glyph fills
monotonically as the test materializes and changes shape at green
and refactor, so the phase reads without colour:

| State | Glyph | Colour |
|---|---|---|
| Plan | `○` | yellow |
| Write | `◔` | yellow |
| Red, unverified | `◑` | red |
| Red, verified | `●` | red |
| Green | `✓` | green |
| Refactor | `◆` | blue |

Idle shows nothing on either surface. The loop survives a
`/reload`: it persists to session history and restores on
session start.
