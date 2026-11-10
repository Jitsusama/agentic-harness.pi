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

screens.test.ts holds hosted conversations to pi's own screen. A sealed
host process composes hostScreens, createEngine and serveHost as the
host program does, on a pi built with the host's patches answering from
pi's scripted provider. Viewers attach through its socket as mycelium's
client does, and each one's screen is read through xterm's headless
terminal. Each case is something a person relies on at pi's own screen.
It needs that pi, named by PI_HOST_PACKAGE_DIR, and is skipped without
one. Run it before merging a change to host/screen, lib/core/viewer or
the host's composition:

```sh
PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
  tests/host/end-to-end/screens.test.ts
```

The root is the pi-monorepo folder of the work host's piHostRuntime (its
lib/node_modules/pi-monorepo), or core's hostedPi, as for the engine's
own tests in tests/host/engine.

The host asks pi's startup questions as the program does, so a
conversation in a folder with its own .pi/extensions asks whether to
trust it, on its screen. The trust cases answer it yes, no, from a
second viewer, and not at all when the conversation closes, and check
whether the folder's extension loaded. Every other case's folder is
trusted in pi's store before it opens, so it asks nothing: pi counts any
.agents/skills above a folder but HOME's as the project's, and a quest's
TMPDIR is a link into a home that holds one.

- `fixtures/`: programs a test runs as a process of its own: the screen
  host.
- `support/`: the seal, a host process and its control requests, and
  the fake engine a host imports by path until H1's createEngine lands;
  the screen host's process, working folders and the trust store that
  judges them, and a viewer reading its screen.
