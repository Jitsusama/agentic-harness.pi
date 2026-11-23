# Test Setup

What vitest runs around every unit test, named in `vitest.config.ts`: every
XDG directory pointed at a throwaway tree, one temp root per run, the quest
workflow's signal listeners taken back out, the quest lock pointed at an
empty runtime folder rather than the machine's own, and a note of which
pi install the suite runs under. `xdg-sandbox.test.ts` proves the sandbox holds.

`scripts-as-text.ts` is a loader each project takes, so a test can
import a shell script it runs, as its text, and `--changed` follows an
edit to that script, or to one it sources or runs from beside it, to
the test; `scripts.d.ts` gives such an import its type.

`chrome-present.ts` is the browser lane's, named in
`vitest.browser.config.ts`: it fails the lane before any test runs where
there is no Chrome to drive. `chrome-present.test.ts` proves it refuses.
