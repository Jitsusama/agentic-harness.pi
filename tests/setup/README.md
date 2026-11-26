# Test Setup

What vitest runs around every unit test, named in `vitest.config.ts`: every
XDG directory pointed at a throwaway tree, one temp root per run with a
short folder for sockets beside it (`PI_TEST_SOCKET_ROOT`), the quest
workflow's signal listeners taken back out, the quest lock pointed at an
empty runtime folder rather than the machine's own, and a note of which
pi install the suite runs under. `xdg-sandbox.test.ts` proves the sandbox holds.

`scripts-as-text.ts` is a loader each project takes, so a test can
import a shell script it runs, as its text, and `--changed` follows an
edit to that script, or to one it sources or runs, to the test;
`scripts.d.ts` gives such an import its type. `scripts-as-text.test.ts`
proves what it follows, and `scripts-as-text-changed.test.ts`, in the
process lane, that vitest's own `--changed` then runs the test.

`chrome-present.ts` is the browser lane's, named in
`vitest.browser.config.ts`: it fails the lane before any test runs where
there is no Chrome to drive. `chrome-present.test.ts` proves it refuses.
