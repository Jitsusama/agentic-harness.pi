# Output Ceiling Workflow

Caps the size of a result from a fat-tailed tool, keeping a way back to
the part it cut.

## Why These Tools, and Not Bash

`read`, `slack`, `vault`, `grokt_bulk_search` and every `observe_*` tool
have a fat tail in the real corpus: a typical result is small, but a
rare one is enormous, and that rare one pays rent on every remaining
turn of a long session whether or not the rest of it is ever used
again. bash does not have this shape. Its results are uniformly small,
so a ceiling on it would never fire, which is why it is not in the set
this extension touches.

## Off by Default, On Purpose

Cutting a result is a quality trade, not provable waste: the truncated
remainder might have been the part that mattered. There is no sensor
yet that could catch that trade going wrong, so this stays behind
`PI_OUTPUT_CEILING_CHARS`. Leaving it unset changes nothing at all.

When it is set, the full result is written to a temporary file before
it is cut, the same convention pi's own bash tool already uses for its
own truncated output, so a truncated result is always recoverable by
the path named in the truncation notice.

## Files

- `index.ts`: registration and the `tool_result` hook.

The cutting decision itself, `applyCeiling`, lives in
`lib/reduction/`, since it needs nothing from pi and is exercised
directly by its own tests.
