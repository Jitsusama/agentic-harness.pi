# Hosted Screens

One persistent pi screen per hosted conversation. The engine calls
`screens.opened`, `rebound` and `closed` under withSession as
conversations come and go; each opening builds pi's own InteractiveMode
over a ViewerTerminal and runs it, so the screen keeps its state with
nobody watching. The service's viewer bridge (`viewer`) lets any number
of viewers join a screen by its pi session id.

A screen that quits, crashes or fails closes only its own conversation,
through the view's `close`. A conversation closed elsewhere (the
launcher's Close, a host stop) stops its screen without closing it
again. A window closing only detaches its viewer. A rebind after pi
replaced the session keeps the screen, its runtime and its viewers under
the new id, and refuses a different runtime.

`hostedModeOf` takes the InteractiveMode class the host's pi exports and
refuses one without core.nix's `pi-host-interactive-lifecycle.patch`,
whose screens would own the host's process exit and signals.
