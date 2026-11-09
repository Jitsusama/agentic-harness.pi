# Persistent Viewer Terminal

A pi-tui Terminal for one hosted conversation, not a second screen
implementation. H2's socket service owns framing, validation, output queue
bounds and disconnects. This module owns viewer input parsing, minimum
geometry and session-scoped callbacks. No socket or process tty is opened.

Attach a sink with rows, columns, write and disconnect. Its attachment
accepts input, resize and detach. The sink's write must enqueue without
blocking; H2 bounds that queue to 4 MiB. Detach leaves pi and pending panels
running. Dispose releases viewer buffers when the conversation closes.

The repaint callback must request a full pi render, including on a
same-size join. It and pi's input and resize callbacks run inside
withSession. One StdinBuffer per viewer prevents split escape sequences and
bracketed pastes from crossing connections. Incomplete input is bounded to
1 MiB per viewer. With no viewers, geometry retains its last value.

This terminal assumes kitty keyboard protocol is already enabled by the
client. The host's one theme, keymap and terminal capability profile belong
to Joel; H2 must refuse clients that do not match that profile. Negotiation,
image-path admission and client tty restoration are not implemented here.

InteractiveMode lifetime and its process-global exit, signal, suspend and
fatal paths still require host-only pi adaptation. Unit transport tests
are not evidence of screen isolation or an actual panel being answered.
