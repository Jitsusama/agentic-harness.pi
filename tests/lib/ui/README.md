# UI Tests

The tests of `lib/ui`: its panels, gates, prompts, dock and the
pieces they draw with, each against a fake pi screen
(`pi-screen.ts`) and theme (`fake-theme.ts`) rather than a
terminal.

The tests of the gate and prompt modules sit in `gate/` and
`prompt/`, as those modules do in `lib/ui`. A test sits by what it
imports, not its name: `gate-close` and `gate-session-end` test how
`mount.ts` and `panel.ts` close a gate, and `prompt-wants` tests the
prompts `panel.ts` offers, so they stay here. The panel family's one
test, `panel-footer`, stays here too, since a folder of one would
say less than its name does.
