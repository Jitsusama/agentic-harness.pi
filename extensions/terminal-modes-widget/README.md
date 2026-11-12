# Terminal Modes Widget

Says pi's terminal modes again whenever its terminal changes size, and
draws the whole screen afresh.

## Why It Exists

pi enters its terminal modes once, as it starts: the alternate screen
with autowrap off and mouse reporting in fullscreen, bracketed paste,
and kitty's keyboard protocol or xterm's modifyOtherKeys. A held
session is shown by a terminal that joins it later, and that terminal
was never told. After the 30 October restore every window Joel used
was such a one: no mouse, no bracketed paste, a screen drawn into
scrollback, and an editor that had lost its bottom rule.

## What It Does

A terminal joining a held session changes the size pi reads, so on
each resize it writes the modes pi is in, read off pi-tui's own state,
then asks for a full redraw. Each is the sequence pi-tui itself writes,
so a terminal already in a mode is unchanged. kitty's keyboard flags
are a stack, so they are popped before they are pushed: however often
this runs, one entry stands, and pi's single pop at exit clears it. A
frame's synchronized-output bracket (`?2026`) isn't a mode and isn't
said.

mycelium's holder replays the modes it saw a program enter to each
terminal that joins, which is the lasting fix; this reaches the
sessions held before that, and agrees with it.

## Counting Full Redraws

As a session starts in a terminal, it turns on pi-tui's log of full
redraws (`PI_TUI_DEBUG_REDRAW=1`) unless the person set that
themselves, `0` included (`redraws.ts`). pi-tui writes a line to
`~/.pi/agent/pi-tui-debug.log` at each one, saying why, and reads the
setting at every render. `node scripts/redraw-tally.ts [--since
<ISO>]`, run from this repository, counts them by reason, so the fix for ask dialogs losing
their text while a reply streams in (Joel, 11 November) starts from
what happens most. The log names no session, so the count is every
pi's together. Past 8 MB it is set aside as `pi-tui-debug.log.1`,
keeping one older copy. Hosted conversations aren't counted: their
screens share the host's process, whose environment this leaves
alone.

It draws nothing: its widget is only how it is handed pi's TUI. Where
pi draws to no terminal, it does nothing.
