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
be written, or isn't there, there is no short folder; a /tmp that isn't
there, or isn't a folder, is said. A run killed
outright leaves its short folder in /tmp, so each run first sweeps this
account's whose process is gone, reading only names in the setup's
shape. A pid is judged only in the pid namespace that wrote it, since
each fenced command on Linux has its own. A folder whose pid lives stays
at any age. One whose pid can't be judged goes after a day unchanged.
A live run touches its folder hourly while its process runs, and one
asleep or stopped that long makes its folder again at its next touch if
a sweep took it. One with no run file, or an empty one, goes after an
hour if nothing else is in it, whoever made it; one with anything else
inside is left as it is. One whose run file isn't the
setup's stays. `temp-root.test.ts` proves the setup and the sweep.

`scripts-as-text.ts` is a loader each project takes, so a test can
import a shell script it runs, as its text, and `--changed` follows an
edit to that script, or to one it sources or runs, to the test;
`scripts.d.ts` gives such an import its type. `scripts-as-text.test.ts`
proves what it follows, and `scripts-as-text-changed.test.ts`, in the
process lane, that vitest's own `--changed` then runs the test.

`chrome-present.ts` is the browser lane's, named in
`vitest.browser.config.ts`: it fails the lane before any test runs where
there is no Chrome to drive. `chrome-present.test.ts` proves it refuses.
