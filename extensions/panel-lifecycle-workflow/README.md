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

It also registers `Ctrl+Alt+N`, which walks the keyboard from
the editor through every widget docked above it, one press
each, and back to the editor: a waiting gate first, then each
progress widget in the order it docked (a running fleet's
board, a council's). Every widget's footer counts the presses
from wherever the keys are and names what the next press
reaches, so two fleets at once are both within reach and
both say how. Progress widgets leave
the editor focused so a person can keep typing while work
runs; this is how their own keys are reached. A gate takes
the keyboard itself, and the chord is how a person leaves it
to type a steer and comes back.

## What a Gate Needs to Know

A docked gate takes the keyboard only once the person has
stopped typing, including typing from before it arrived, so
this extension watches every key for the whole session rather
than leaving it to widgets that come and go. It also notes
when pi announces a session replace (`/new`, `/resume`,
`/fork`), because the teardown that follows stops the turn,
and a gate that stop closes would otherwise leave its record
in a transcript about to be rebuilt without it. The next
prompt, turn or session clears the note, since another
handler may cancel the replace.

One extension registers it because pi keeps one handler per
shortcut, and the dock that answers it is process-global, so
one registration serves the widgets of every package.
