# Screen Tests

screens.test.ts drives host/screen/ with a stand-in for pi's hosted
InteractiveMode: a screen runs in its session before anyone watches,
quitting one closes only its conversation, a close from elsewhere stops
the screen once, a failure closes and reports, and a rebind keeps the
viewers under the new id. The real InteractiveMode's hosted paths are
proved by core.nix's `pi-hosted-screen-stays-in-its-session` check.
