# Working Spinner Widget

Keeps pi's working spinner turning only in the window the person is in,
and shows a still mark (●) in every other window that is working.

## Why It Exists

pi turns its spinner every 80 ms while a session works. Each turn is a
write to the terminal, which wakes it, and the compositor redraws. On
7 November kitty switched context about 990 times a second at 19% of a
core, and niri spent 35 to 49% of one refreshing its windows. On
8 November 20 sessions were working at once, which comes to about 250
frames a second, almost all in windows nobody was looking at.

## What It Does

It reads focus from the terminal's focus reports, which pi asks for in
fullscreen, and from keys and clicks, which reach only the focused
window. The pointer passing over a window, or a scroll, says nothing
about focus. A still mark is a single frame, which pi draws once and
never times.

Until a window hears it has focus, the mark is still. A window spawned
beside the person's never gains focus, so waiting to hear it lost
focus would leave it turning for good. The window the person types in
turns again with the first key.

Where pi draws to no terminal, it does nothing.
