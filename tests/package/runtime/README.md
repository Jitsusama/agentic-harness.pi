# Rules a Running Session Keeps

State and processes while the package runs: session state is keyed by
session rather than held for the process, a turn's end has one listener,
and a reviewer's run gets one grace to flush, one way to be stopped, and
a journal bound on disk. Every clock over some work is a `deadline`
from `lib/clock`, since on node 22 a signal joined to node's own
timeout signal is never let go of once something else stops it.

`session-state.ts` finds the sites the keyed-state test counts.
`session-state-waiting.txt` lists the sites still to be keyed, and only
shrinks; `session-state-exempt.txt` lists those that are process
infrastructure, with why.
