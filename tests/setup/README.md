# Test Setup

What vitest runs around every unit test, named in `vitest.config.ts`: every
XDG directory pointed at a throwaway tree, none of the developer's
session left in its environment (its sandbox, desktop and `MYCELIUM_`
variables), one temp root per run with a
short folder for sockets in /tmp (`PI_TEST_SOCKET_ROOT`), the quest
workflow's signal listeners taken back out, the quest lock pointed at an
empty runtime folder rather than the machine's own, and a note of which
pi install the suite runs under. `xdg-sandbox.test.ts` proves the sandbox holds.
`held-session.ts` picks which `MYCELIUM_` names go: all but those a caller
chose for the run, such as `MYCELIUM_BIN`, which `held-session.test.ts`
proves on an environment it plants.

The run's end removes its temp root and short folder. Where /tmp may not
be written there is no short folder. A run killed outright leaves its
short folder in /tmp, so each run first sweeps this account's whose
process is gone. A pid is judged only in the pid namespace that wrote
it, since each fenced command on Linux has its own; a folder whose pid
can't be judged goes after a day, and one with no run file after an
hour. `temp-root.test.ts` proves the setup and the sweep.

`scripts-as-text.ts` is a loader each project takes, so a test can
import a shell script it runs, as its text, and `--changed` follows an
edit to that script, or to one it sources or runs, to the test;
`scripts.d.ts` gives such an import its type. `scripts-as-text.test.ts`
proves what it follows, and `scripts-as-text-changed.test.ts`, in the
process lane, that vitest's own `--changed` then runs the test.

`chrome-present.ts` is the browser lane's, named in
`vitest.browser.config.ts`: it fails the lane before any test runs where
there is no Chrome to drive. `chrome-present.test.ts` proves it refuses.
