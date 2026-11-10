# UI Tests

The tests of `lib/ui`: its panels, gates, prompts, dock and the
pieces they draw with, each against a fake pi screen
(`pi-screen.ts`) and theme (`fake-theme.ts`) rather than a
terminal.

Many entries because they mirror `lib/ui`, which is past 40 itself
and waits in `tests/package/long-files-waiting.txt`; splitting the
tests before the library would leave them mirroring nothing.
