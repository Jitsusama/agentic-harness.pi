# Persistent Viewer Terminal

A pi-tui Terminal for one hosted conversation, not a second screen
implementation. H2's socket service owns framing, validation, output queue
bounds and disconnects. This module owns viewer input parsing, minimum
geometry, mode replay and session-scoped callbacks. No socket or process tty is opened.

Attach a sink with rows, columns, write and disconnect. Its attachment
accepts input, resize and detach. The sink's write must enqueue without
blocking; H2 bounds that queue to 4 MiB. Detach leaves pi and pending panels
running. Dispose releases viewer buffers when the conversation closes.
`isEditing` says whether a viewer has a draft out in its own editor,
which a host waits out before restarting.

A frame is drawn only while a viewer is attached: with nobody watching,
`renderScope` skips it, since every conversation in a host shares one
thread, and the join's repaint draws the whole screen for whoever comes.

`confirmQuit` judges a quit pi was asked for. One no viewer's key asked
for, such as an extension's shutdown, holds at once, and so does one a
lone viewer typed, as plain pi's quit keys do. One a viewer typed with
others watching is asked of that viewer alone, on its bottom row, with
its frames held until it answers: only y holds it, and any other key (a
paste or Ctrl+D again among them) lets that viewer go with
`LEFT_RUNNING` and leaves the conversation running. A viewer that leaves
first, or a close elsewhere, is no yes. A viewer whose input ends only
detaches.

A parked conversation keeps its terminal and viewers. `sleep(wake)`,
called before its screen stops, holds every key its viewers type, in
order and bounded to 1 MiB per viewer, calling `wake` at the first.
`awake()`, once the screen it wakes into has started, hands the held
keys to that screen, each as its viewer typed it, so none is lost to
the wake. A wake that fails is said on the screen, and the next key
asks again, the keys before it still held.

The repaint callback must request a full pi render, including on a
same-size join. It and pi's input and resize callbacks run inside
withSession. One StdinBuffer per viewer prevents split escape sequences and
bracketed pastes from crossing connections. Incomplete input is bounded to
1 MiB per viewer. Invalid resize disconnects that viewer rather than
throwing into a shared socket handler. Pi renders at the minimum row count
and minimum column count across joined viewers, so a larger viewer sees
the same smaller canvas. With no viewers, geometry retains its last value.

Pi asks its terminal for its private modes once, as it starts: the
alternate screen, autowrap, mouse reports, a hidden cursor. `modes.ts`
reads them from pi's output, so a viewer joining later is first given
every mode but the screen, then the screen, then kitty's keyboard flags
(7) and bracketed paste, which pi's own terminal would have pushed and
which follow the screen because kitty keeps flags per screen. Only then is
it repainted. A viewer whose first output fails is refused. Synchronized
output (2026) is a frame bracket, not a mode, and is not replayed. Each
client stays a byte pipe that resets its own tty as it leaves.

The host's one theme, keymap and terminal capability profile belong to
Joel; H2 must refuse clients that do not match that profile. Image-path
admission is not implemented here.

The screen layer (`host/screen/`) runs pi's InteractiveMode on this
terminal, with core.nix's host-only pi patch for its exit, signal,
suspend and fatal paths. Unit transport tests are not evidence of an
actual panel being answered.
