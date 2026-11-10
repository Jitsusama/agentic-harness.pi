# End-to-End Host Tests

A whole host as its own process, started as systemd starts it, under a
sealed HOME, XDG folders and TMPDIR, driven over its control socket. It
mirrors no source folder: what it checks spans the engine, the service
and every conversation's harness. These are the integration checks E1
to E5 of the keying design, and the ground they stand on.

sealed-host.test.ts proves that ground on a fake engine: two
conversations served from the seal, one ended at close with the other
kept, both back under their ids after a kill, and both parked at a stop
signal and resumed at the next start.

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

mesh.test.ts is E1: two conversations in one host, on H1's engine and
pi's own runtime with this harness loaded and a scripted model, play
ping-pong over the mesh. One is told to ping the other's address; the
other is handed the question, which starts its turn, and answers pong.

steer.test.ts is E2: a mycelium node of the sealed realm sees both
conversations idle, a steer it delivers reaches the one it names and no
other, and once that one is closed the node no longer holds it while
the other stays idle. A hosted conversation forgets its presence as it
closes, since its host lives on (the keying design's 2.5).

restart.test.ts is E4: one conversation stores a query's rows under a
handle, the host is killed outright, and once a new host has resumed
both, a steer to the old address reaches it and its query of the old
handle answers.

Every file here is in the process lane, since each spawns node from
node.

## The Host's Pi

E1 to E5 run on a pi built with the host's patches, which an ordinary
check can't build. `pnpm test:host` runs them on the pi
`PI_HOST_PACKAGE_DIR` names (a pi-monorepo folder), else on the one under
the link H2 keeps to the latest piHostRuntime build,
`$XDG_STATE_HOME/pi-host/runtime`, a GC root. It fails rather than
skips when neither holds one, since no CI runs these. To make one, `tec
build //home/joel-gerber/dotfiles:piHostRuntime` and link it there.

A test run sandboxes every XDG folder, so a check can't see the link
itself: `pnpm test:host` resolves it in its shell and passes it in as
`PI_HOST_RUNTIME`. An ordinary run, with no pi named, skips each check
saying how to run it.

The rollout runs `pnpm test:host` against the re-pinned piHostRuntime
before any machine names a realm for a host.

E2 also needs `mycelium` on the PATH, for a node of the sealed realm;
without it the check skips, or fails under `pnpm test:host`, saying so.

- `fixtures/`: programs a test runs as a process of its own: the screen
  host.
- `support/`: the seal, a host process and its control requests, the
  host's pi as the checks find it, what every case on it shares (a
  session file and its tools' answers read as they grow, a steer written
  into an inbox), a sealed mycelium node, and the engines a host imports
  by path: the fake one, and H1's createEngine with the scripted model;
  the screen host's process, working folders and the trust store that
  judges them, and a viewer reading its screen.
