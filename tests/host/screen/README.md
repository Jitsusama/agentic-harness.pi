# Screen Tests

screens.test.ts drives host/screen/ with a stand-in for pi's hosted
InteractiveMode: a screen runs in its session before anyone watches,
quitting one closes only its conversation, a close from elsewhere stops
the screen once, a failure closes and reports, and a rebind keeps the
viewers under the new id. A question asked before the screen goes to a
terminal viewers can join and the screen keeps, and a close settles it
unanswered. The real InteractiveMode's hosted paths are proved by
core.nix's `pi-hosted-screen-stays-in-its-session` check.

startup-ask.test.ts draws a startup question with pi-tui's own
main-screen TUI over a ViewerTerminal, with a stand-in for pi's
selector, and answers it by a pick, a dismissal or a cancel.
