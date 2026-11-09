# Test Setup

What vitest runs around every unit test, named in `vitest.config.ts`: every
XDG directory pointed at a throwaway tree, one temp root per run, the quest
workflow's signal listeners taken back out, and a note of which pi install
the suite runs under. `xdg-sandbox.test.ts` proves the sandbox holds.

`chrome-present.ts` is the browser lane's, named in
`vitest.browser.config.ts`: it fails the lane before any test runs where
there is no Chrome to drive. `chrome-present.test.ts` proves it refuses.
