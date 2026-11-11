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
viewer can attach to reply, whether it asks through one of pi's dialogs
or a component of its own, over the screen or in the editor's place.
The component cases need a pi from core.nix#2853 or later.

keys.test.ts holds the keys and the mouse a person uses at pi's own
screen to that same host: scrolling a long answer with the wheel and by
key, jumping between prompts, searching it, stopping a turn, opening
the tree, clearing the editor, queueing a follow-up and taking it back,
breaking a line, killing, yanking and undoing in the editor, expanding
a tool's output and thinking, picking a model, and copying a drag. Each viewer sends what kitty sends
under the keyboard protocol pi asks for. The host's scripted model
holds an answer named "hold until <file>" until the turn is stopped or
the file appears in HOME, so a case can act during a run. Run it as
screens.test.ts is run, naming it instead.

screen-faults.test.ts gives one of two conversations on that host a
footer that throws on every frame, as a stale extension's once did,
ending every conversation in its host. The throw stays in its own
conversation: its extensions' screen comes down, then a second throw
closes it, while the other conversation answers throughout. Run it as
screens.test.ts is run, naming it instead.

attach-client.test.ts runs mycelium's own attach client in a real
terminal against the same sealed host: an interactive bash under
script(1)'s pseudo-terminal, which joins a conversation as the
launcher's Go To does, its screen read through xterm's headless
terminal. Ctrl+G runs a scripted editor in that terminal, and Ctrl+Z
stops the client by bash's own job control until fg. Closing the window
only leaves the conversation. Its folders are trusted in pi's store as
the screen cases' are. It runs on the host's pi as E1 to E8 do (The
Host's Pi, below), with script(1) and a mycelium whose client edits and
suspends (mycelium#112), named by MYCELIUM_BIN or else on the PATH:

```sh
PI_HOST_PACKAGE_DIR=<root> MYCELIUM_BIN=<mycelium>/bin/mycelium \
  pnpm exec vitest run --project process \
  tests/host/end-to-end/attach-client.test.ts
```

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

cutover.test.ts is E9, wave 3's cutover and its rollback as
`scripts/host-cutover.ts` and `scripts/host-release.ts` run them: ten
plain pis, five a person prompted and five only a peer's message woke,
move into the attended and background hosts by who drives them, keeping
their sessions and addresses, and each answers there. A stand-in `qs` on
PATH answers the cutover's keepPlace, so the windows it couldn't put
back are listed. The release hands all ten back: restore.json offers
each as released, the first one's quest journal says what only the
host held, and each answers again in plain pi from the same file, the
set in less than 45 minutes. Each plain pi runs in a terminal
of its own under script(1) (support/terminal-pi.ts), as Joel's do,
since pi over RPC holds a session's ending for its client's next
command.

follow-install.test.ts is E10: the host's conversations load the
harness from an install kept as pi-packages keeps one, a `current`
link onto a folder of versions. Once the link moves, a steer's run ends
with the host reloading the conversation, and its new runtime says the
move was its own and that it runs the new version.

screen-reload.test.ts reloads a hosted conversation through its host,
as the follower does, on the screen host: its screen draws the new
load's footer, takes a resize and the next words, and the host stays
up. The fixture's footer reads its load as it draws, and each load asks
for a frame before setting its own, so a screen still drawing the old
load's footer throws, as the background host did on 11 November.

quit.test.ts types pi's quit in one viewer of a hosted conversation. On
11 November script(1), its input ended, typed Ctrl+D into a check's
window, and the conversation closed for everyone with no word in the
journal. Here a window whose input ends leaves it running. A lone
viewer's Ctrl+D, /quit or Ctrl+C twice closes it as plain pi does,
under Joel's own Ctrl+D bindings, and a Ctrl+D typed into words deletes
forward and never quits. With another viewer watching, the viewer that
typed the quit is asked alone: y closes it for everyone, anything else
lets only that viewer go. Each end is a line in the host's journal
naming the viewer or the caller that asked.

footer.test.ts reads pi's own footer on hosted screens: each
conversation's folder and git branch, not the host's, redrawn when the
branch moves; a status line an extension sets, changes and clears, on
every viewer; and the model and thinking level as Ctrl+P, Ctrl+Shift+P
and Shift+Tab cycle them.

park.test.ts parks three conversations on the screen host by the
harness's own park-workflow, the switch naming each, and has the host
weigh itself (SIGHUP, with its garbage collected): no parked
conversation's session is left in memory, and the host weighs less.
Each wakes in place a different way: keys typed in its window, all of
them read once it wakes; a window opening on it; and the wake file its
marker names, written as the mesh writes it. It waits out the rule's
two minutes and its minute between looks once, for all three.

killed-busy.test.ts is E11: three conversations share a host, one
mid-turn in a tool that never ends by itself, when the host is killed
outright. A new host resumes all three under their ids, each log keeps
what it held before the kill and holds only whole entries, the killed
run is taken up again (and stopped) or answered, and then all three
answer.

release-all.test.ts is E12, item 11's rollback drill: `host-release.ts
--all` from both hosts, holding two conversations each, one mid-run.
The release waits on the busy one until a Stop, then both hosts are
empty and restore.json offers all four. Each log is whole and keeps
what it held, and reopened from its file each runs in one plain pi
under its addresses, and answers.

Each seal serves a realm of its own, since a host starting reaps what a
dead host under its key left running.

Every file here is in the process lane, since each spawns node from
node.

## The Host's Pi

E1 to E8 run on a pi built with the host's patches, which an ordinary
check can't build. `pnpm test:host` is the host's one gate: it runs
every file here, with the engine's own (tests/host/engine) and the
parity test (tests/host/parity), on the pi
`PI_HOST_PACKAGE_DIR` names (a pi-monorepo folder), else on the one under
the link H2 keeps to the latest piHostRuntime build,
`$XDG_STATE_HOME/pi-host/runtime`, a GC root. It fails rather than
skips when neither holds one, since no CI runs these. To make one, `tec
build //home/joel-gerber/dotfiles:piHostRuntime` and link it there.

A test run sandboxes every XDG folder, so a check can't see the link
itself: `pnpm test:host` resolves it in its shell and passes it in as
`PI_HOST_RUNTIME`. An ordinary run, with no pi named, skips each check
saying how to run it. Under `pnpm test:host` any case that skips, for
whatever reason, fails the run: its reporter
(support/every-case-ran.mts) lists each with its note.

The rollout runs `pnpm test:host` against the re-pinned piHostRuntime
before any machine names a realm for a host.

E2 also needs `mycelium` on the PATH, for a node of the sealed realm;
without it the check skips, or fails under `pnpm test:host`, saying so.

- `fixtures/`: programs a test runs as a process of its own: the screen
  host, and E9's stand-in mycelium.
- `support/`: the seal, a host process and its control requests, the
  host's pi as the checks find it, what every case on it shares (a
  session file and its tools' answers read as they grow, a steer written
  into an inbox), a sealed mycelium node, and the engines a host imports
  by path: the fake one, and H1's createEngine with the scripted model;
  the scripted model itself, the extension that gives a plain pi the
  same model, a plain pi driven over RPC, and what the launcher would
  offer to reopen from the seal's session records; the screen host's
  process, working folders and the trust store that judges them, a
  screen drawn and read back, a viewer reading its screen through the
  socket, and a shell in a terminal of its own; and the gate's reporter,
  failing a run in which any case skipped.
