# Rules the Package Keeps

Tests that read the whole package at once, for promises no single file's
tests can hold: docs name only what exists, every folder says what it holds,
tools say the glossary's words, refusals say what to do, one glyph means one
thing, and the like. Each file opens by saying the rule and why it is held.

They are grouped by what they hold the package to:

- `code/`: how the code is laid out, its seams, helpers, imports and
  long files.
- `runtime/`: state and processes while the package runs.
- `shipping/`: what a consumer installs and loads.
- `suites/`: how the package's own tests are written.
- `tools/`: how a tool is registered and answers.
- `ui/`: what pi draws, its glyphs, marks, panels and rows.
- `words/`: what the package writes, its docs, notes, refusals and
  prose.

`hosted-loads-add-no-process-listeners.test.ts` stays here, beside them:
vitest.config.ts runs it in the process lane by this path, and a change
there would hold the move to a whole host run.
