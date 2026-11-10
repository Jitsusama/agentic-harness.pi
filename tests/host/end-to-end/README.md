# End-to-End Host Tests

A whole host as its own process, started as systemd starts it, under a
sealed HOME, XDG folders and TMPDIR, driven over its control socket. It
mirrors no source folder: what it checks spans the engine, the service
and every conversation's harness. These are the ground the integration
checks E1 to E5 of the keying design stand on.

sealed-host.test.ts proves that ground on a fake engine: two
conversations served from the seal, one ended at close with the other
kept, both back under their ids after a kill, and both parked at a stop
signal and resumed at the next start. It is in the process lane, since
it spawns node from node.

- `support/`: the seal, a host process and its control requests, and
  the fake engine a host imports by path until H1's createEngine lands.
