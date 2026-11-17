# Rules a Running Session Keeps

State and processes while the package runs: session state is keyed by
session rather than held for the process, a turn's end has one listener,
and a reviewer's run gets one grace to flush, one way to be stopped, and
a journal bound on disk.

`session-state.ts` finds the sites the keyed-state test counts.
`session-state-waiting.txt` lists the sites still to be keyed, and only
shrinks; `session-state-exempt.txt` lists those that are process
infrastructure, with why.
