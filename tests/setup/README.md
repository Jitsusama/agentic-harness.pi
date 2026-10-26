# Test Setup

What vitest runs around every unit test, named in `vitest.config.ts`: every
XDG directory pointed at a throwaway tree, one temp root per run, the quest
workflow's signal listeners taken back out, and a note of which pi install
the suite runs under. `xdg-sandbox.test.ts` proves the sandbox holds.
