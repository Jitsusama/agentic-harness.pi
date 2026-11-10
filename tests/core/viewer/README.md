# Viewer Tests

Observable transport behaviour through ViewerTerminal: output fanout,
independent input buffers, canonical geometry, detach survival, bounds,
the modes a late viewer is given before its repaint, a rebind onto a new
session id, pi's key reader told its viewers speak kitty's protocol, an
edit or a suspend handed to the one viewer that pressed the key (and
refused to one whose client can't), and session dispatch in a fake Host
with two conversations. These unit tests
use no desktop, socket service, model or real InteractiveMode.
