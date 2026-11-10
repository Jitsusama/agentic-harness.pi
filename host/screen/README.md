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

A question pi asks before a conversation's screen exists, whether to
trust its project folder, comes through `askProjectTrust` when the host
gives the screens an asker. `startup-ask.ts` shows it as pi's CLI shows
its startup selector: pi's ExtensionSelectorComponent in a main-screen
TUI of its own, on a terminal made early for the conversation. Viewers
can join it there, and the screen takes the same terminal once it opens.
Questions follow one another there, never two at once. A close while one
waits answers it with nothing, which is untrusted, and lets its viewers
go. `hostedAskerOf` takes the selector and pi-tui's TuiMainScreen from
the host's pi as it loaded them, since host code imports no pi of its
own, and refuses either missing.
