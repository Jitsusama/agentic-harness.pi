# Panel Lifecycle Workflow

Closes every panel when its session ends: on `/new`, `/resume`,
`/fork`, `/reload` and quit. Panels on screen and panels still
waiting for the screen alike answer the way Escape would, so a
gate fails closed.

Without it, a panel raised outside a turn outlived its session.
Pi's reset hides the topmost overlay but never settles the
panel, so the shared gate queue stayed held and every later
panel waited behind it, in this session and the next. A panel
still waiting would mount in the next session instead, asking
about a conversation nobody could see.

The panels themselves are tracked by `lib/ui`'s panel registry,
which is process-global, so this one handler closes the panels
of every package carrying its own copy of the library.

## The Hop Chord

It also registers `Ctrl+Alt+N`, which moves the keyboard from
the editor into the topmost widget docked above it (a running
fleet's board, a council's) and back again. The widgets leave
the editor focused so a person can keep typing while work
runs; this is how their own keys are reached.

One extension registers it because pi keeps one handler per
shortcut, and the dock that answers it is process-global, so
one registration serves the widgets of every package.
