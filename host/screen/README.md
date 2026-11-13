# Hosted Screens

One persistent pi screen per hosted conversation. The engine calls
`screens.opened`, `rebound` and `closed` under withSession as
conversations come and go; each opening builds pi's own InteractiveMode
over a ViewerTerminal and runs it, so the screen keeps its state with
nobody watching, drawing no frame until someone joins. The service's
viewer bridge (`viewer`) lets any number of viewers join a screen by its
pi session id.

A screen that quits, crashes or fails closes only its own conversation,
through the view's `close`, with a reason naming who asked. A quit a
lone viewer typed holds as in plain pi; one typed with others watching
holds only once that viewer confirms it (the terminal's
`confirmQuit`), through `hosted.quit`, which pi asks before its hosted
quit. A conversation closed elsewhere (the
launcher's Close, a host stop) stops its screen without closing it
again. A conversation parked while idle (`parked`) stops its screen as
a close does, but keeps its terminal and viewers, shows them
`PARKED_LINE`, and holds what they type from before the stop; the
first key wakes it, and the screen it wakes into (`opened`) takes the
terminal and every held key. A window closing only detaches its viewer.
Each viewer of a conversation that ends is told why: "Conversation
released" when it was released back to plain pi, which its window can
then start, and "Conversation closed" for any other end. A rebind after
pi replaced the session keeps the screen, its runtime and its viewers under
the new id, and refuses a different runtime.

`resting` says whether a host may restart without anyone losing a
thing: every screen started, pi's editor focused and empty with no
overlay, no gate docked or waiting for the screen (read in the
conversation's session, lib/ui/screen-gates.ts), no answer,
compaction, command or queued message under way, and no viewer
editing a draft in its own editor. It reads pi's private
parts without trusting their type, and counts a screen it can't read
as in use, so a pi that renamed them keeps its host from restarting.

A reload goes through the screen (`screens.reload`), which runs its pi's
own /reload, as plain pi's follower and /reload do. That takes down the
old load's footer, header, widgets, dialogs and key listeners before pi
invalidates the load. Reloading the session under the screen left them
drawing on that load, whose every read throws, and one such render took
the host down on 11 November.

What a screen throws where nothing catches it, from a frame, a key, a
resize or a timer of its own, ends at its conversation, never the
host's process. The ViewerTerminal hands each such throw to its screen
(`whenFaulted`), and the host's uncaught-exception backstop hands one
it can tie to a conversation to `faulted`. A first throw takes down the
extensions' footer, widgets and panels, as pi's own `/reload` does
before it reloads, and says so on the screen; a second closes that
conversation alone, keeping its log. Only the first two are reported.
A closed screen still contains what its leftover timers throw.

`hostedModeOf` takes the InteractiveMode class the host's pi exports and
refuses one without core.nix's `pi-host-interactive-lifecycle.patch`,
whose screens would own the host's process exit and signals, or one
from before that patch's hosted quit (`InteractiveMode.hostedQuit`),
whose screens would quit without asking.

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
