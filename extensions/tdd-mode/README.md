# TDD Mode Extension

Skill-driven red-green-refactor tracking with LLM-facing
enforcement.

The [TDD workflow skill](../../skills/tdd-workflow/) teaches the
methodology and tells the agent when to signal phase transitions.
This extension tracks the state, displays it, and blocks
phase-inappropriate file writes with hints back to the LLM.

## How It Works

The agent calls the `tdd_phase` tool to signal transitions
through the red-green-refactor cycle. Each transition shows a
confirmation gate displaying what was done, what happens next,
and whether to proceed or stay. The extension:

- Tracks the current phase and displays it in the status line
- Shows the current test description below the editor
- Confirms phase transitions with the user via a gate panel
- Blocks test file writes during GREEN and REFACTOR phases,
  returning hints to the LLM (not UI gates for the user)
- Injects phase-appropriate context into the system prompt

### Enforcement

| Phase | Test files | Implementation files |
|-------|-----------|---------------------|
| RED | ✅ allowed | ✅ allowed (stubs expected) |
| GREEN | ❌ blocked | ✅ allowed |
| REFACTOR | ✅ allowed | ✅ allowed |

Blocks go back to the LLM as error messages with phase hints.
The agent self-corrects or calls `tdd_phase stop` if the user
has redirected away from TDD.

## Activation

The agent activates TDD mode via the `tdd_phase` tool when TDD
intent is detected (from user request or plan instructions),
after confirming with the user.

TDD mode can also be toggled manually:

| Method | Description |
|--------|-------------|
| `/tdd [plan-file]` | Toggle TDD mode |
| `Ctrl+Alt+T` | Toggle TDD mode |

## Status Display

When active, the status line shows `🧪: 🔴` (or 🟢 / 🔄).
The current test description appears right-justified above
the editor.
