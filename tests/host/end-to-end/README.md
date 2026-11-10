# End-to-End Host Tests

A whole host as its own process, started as systemd starts it, under a
sealed HOME, XDG folders and TMPDIR, driven over its control socket. It
mirrors no source folder: what it checks spans the engine, the service
and every conversation's harness. These are the integration checks E1
to E8 of the keying design, and the ground they stand on.

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
It runs on the host's pi as E1 to E8 do (The Host's Pi, below), so
`pnpm test:host` runs it with them. Run it alone before merging a change
to host/screen, lib/core/viewer or the host's composition:

```sh
PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
  tests/host/end-to-end/screens.test.ts
```

The root is the pi-monorepo folder of the work host's piHostRuntime (its
lib/node_modules/pi-monorepo), or core's hostedPi.

The host asks pi's startup questions as the program does, so a
conversation in a folder with its own .pi/extensions asks whether to
trust it, on its screen. The trust cases answer it yes, no, from a
second viewer, and not at all when the conversation closes, and check
whether the folder's extension loaded. Every other case's folder is
trusted in pi's store before it opens, so it asks nothing: pi counts any
.agents/skills above a folder but HOME's as the project's, and a quest's
TMPDIR is a link into a home that holds one. An extension that asks the
person before the first words go on answers the open at once, so a
viewer can attach to reply.

mesh.test.ts is E1: two conversations in one host, on H1's engine and
pi's own runtime with this harness loaded and a scripted model, play
ping-pong over the mesh. One is told to ping the other's address; the
other is handed the question, which starts its turn, and answers pong.

steer.test.ts is E2: a mycelium node of the sealed realm sees both
conversations idle, a steer it delivers reaches the one it names and no
other, and once that one is closed the node no longer holds it while
the other stays idle. A hosted conversation forgets its presence as it
closes, since its host lives on (the keying design's 2.5).

budgets.test.ts is E3: two conversations in one host, each opened on
its own quest whose budget names its own file of variables, and each on
its own scripted model, run one command and commit once. Each command
sees only its own budget, variable, session and commit credit, and each
commit credits only its own model.

restart.test.ts is E4: one conversation stores a query's rows under a
handle, the host is killed outright, and once a new host has resumed
both, a steer to the old address reaches it and its query of the old
handle answers. Neither is offered to reopen in a window, with the host
dead or back: the next boot's restore file marks both hosted, so the
launcher's Sessions to Reopen leaves them out, and `quest
reopen-sessions` names neither.

rollback.test.ts is E5, the rollback drill: one conversation is closed
in the host and its log opened in a plain `pi --session`, which
publishes the same session under the same address as a pi of its own,
not a hosted one. It pings the other conversation, still in the host,
and hears pong. The plain pi loads the scripted model as an extension.

spawn.test.ts is E6, a quest's session spawned into a host: a plain pi
orchestrating a parent quest spawns its child quest's session into the
realm's attended host. The child's first words arrive, its presence and
the node show it as the orchestration's, the orchestrator's `mesh_end`
closes it alone through the host's socket, and `/quest-resume`, the
first words of a conversation opened on the child quest, has the host
adopt it again under the same id.

subagents.test.ts is E7: a hosted conversation runs two subagents, each
with the scripted model loaded, and each answers with the pid, node and
arguments of the `pi --mode json` it runs in, read inside the child,
since pi titles itself `pi` and so hides them from ps. Both are the
host's node running the host runtime's own `dist/bundle/cli.js`.

pausing.test.ts is E8, the launcher's Stop and Close on a hosted row,
which reach the conversation as steers: a Stop sent while it is busy
in a long tool cuts that tool short and leaves it listening, a Close
ends it, and the host drops it alone, its neighbour answering
throughout.

Each seal serves a realm of its own, since a host starting reaps what a
dead host under its key left running.

Every file here is in the process lane, since each spawns node from
node.

## The Host's Pi

E1 to E8 run on a pi built with the host's patches, which an ordinary
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
  the scripted model itself, the extension that gives a plain pi the
  same model, a plain pi driven over RPC, and what the launcher would
  offer to reopen from the seal's session records; the screen host's
  process, working folders and the trust store that judges them, and a
  viewer reading its screen.
