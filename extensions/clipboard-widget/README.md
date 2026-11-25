# Clipboard Widget

Ctrl+V in pi's editor under Wayland, read through a small shell the
session forks once, so a paste doesn't wait on the session forking.
And a held pi's copies reach the terminal showing it.

## Why It Exists

pi's own Ctrl+V runs `wl-paste` twice from the session: once to list
what the clipboard offers, once to read it. Each run forks the whole
session, and node waits while the kernel copies its page tables. On
10 November a node holding 1.2 GB took 42 to 114 ms to fork, and once
1055 ms; a 26-hour session took 35 to 625 ms for a single spawn under
45 to 70% IO pressure. Joel, that morning: "ctrl-v takes a long time
right now btw, seconds."

## What It Does

At a session's start it forks a shell, while the session is still
small. Ctrl+V then asks that shell to run each `wl-paste`, and the
shell forks them at almost no cost. The paste reads as pi's does, in
its order: copied files (a `text/uri-list` of local files) as their
paths, then a PNG, JPEG, WebP or GIF image written to a temporary file,
then text. An image pi would convert first, such as a BMP, is passed
over for the text beside it.

The shell reads the clipboard only when Ctrl+V is pressed and keeps
nothing between reads, so no copy of what was copied, a password
included, outlives the paste.

It takes the key only while pi's editor holds the keyboard; in a
picker, a dialog or a panel the key goes to pi as before. It does
nothing off Linux, without a Wayland display, or in Termux. When the
shell can't answer, that paste runs `wl-paste` from the session as pi
does, and the shell is started again after it. It draws nothing: its
widget is there only to be handed pi's screen, to see what holds the
keys.

## Copies From a Held Session

A session a holder keeps may run on one machine while the person sees
it through an attach from another, as a session held on the Mac and
shown on optimus. pi sends a copy to the terminal as OSC 52 only when
it sees SSH markers, or `PI_CLIPBOARD_OSC52=1`, and an attach leaves
none, so a copy went only to the clipboard of the machine pi ran on.
Joel, 25 November: he couldn't copy text out of such a session.

So for a held pi (`MYCELIUM_HELD` set) the widget sets
`PI_CLIPBOARD_OSC52=1` as it loads, on every platform, unless it is
set already. pi reads it on each copy, so every copy after that sends
OSC 52 as well as writing the local clipboard. An unheld pi copies as
pi does. The attach must pass OSC 52 through to the terminal, which is
mycelium's part.
