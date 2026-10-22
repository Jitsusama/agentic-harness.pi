# Mesh Workflow

The pi sessions on one machine as peers on a mesh, coordinating
in shared groups without typing into each other's terminals.
Typing into a terminal lands in whatever the person is typing,
and can answer a question or a gate left open on screen.

## The Language

- **Peer:** a session, addressed by the last six letters of
  the quest it has loaded (`P9R1KI`), so its address survives
  reloads. It also answers to older quests that list it and to
  the last eight characters of its session id.
- **Message:** what a peer sends, signed with its address and
  stamped by the mesh with an id and a time. Its short id is
  the id's last part, shown in brackets (`[2f95756a]`).
- **Reply:** a message that answers another (`re`). An answer
  to a peer's own message is taken as sent to it, wherever it
  went, and its depth is how many answers down the thread it
  is.
- **Supersede:** a message that replaces one its sender sent
  earlier, to withdraw or correct it. It goes wherever that
  one went, so everyone who heard it hears this.
- **Intent:** what a message asks of whoever it reaches: hold,
  question, finding or fyi.
- **Group:** where every message goes. There are no direct
  messages: a peer is reached through its home group, written
  as its address (`P9R1KI`, or `@P9R1KI`), which anyone may
  join to follow it. `#all` is the machine's group. Named
  groups (`#harness`, `#optimus/power`) nest: a member of
  `#optimus/power` also hears `#optimus`.
- **Scope:** a group a peer is in because of its work rather
  than because it joined: its quest's, named down the parent
  chain from the root (`#quest/5gv2ah/luq49e`), and each
  repository's its work is in (`#repo/agentic-harness-pi`).
  A message to `#quest/5gv2ah` reaches every peer on that
  quest or under it. Scopes follow the work and are not left
  while it is there.
- **Joined:** the groups a peer chose, kept across a reload.
- **Presence:** what a peer publishes about itself: its
  addresses, its groups, what it works on and what it owns,
  whether it is mid-run, and the process holding it.
- **Liveness:** whether a peer is still there, asked of the
  machine through the process its presence names.
- **Attention:** what a message gets from the peer it reaches,
  decided by that peer and never none: a glance, a note, an
  act or a wake.
- **Damping:** the peer's limits on that attention, enforced by
  the mesh rather than asked of senders.
- **Stop:** a peer telling another to stop reaching it, which
  only it can lift and which is absolute while it stands.
- **Lease:** an expiring claim a peer holds on what it is in
  the middle of: a file it is changing, a question it is
  answering, a hold it sent, a hold it waits on, or heavy work
  it runs. Presence first, never a lock.
- **Board:** where every peer's leases are kept, for every
  peer to read.
- **Transport:** where messages travel and rest.

## Tools

- `mesh_send`: send a message with an intent to one or more
  groups. It says which peers the message goes to, which
  addressed peers have ended and which addresses nobody goes
  by, and refuses a named group nobody else still there is in.
  A peer reads what it writes to: sending to a named group it
  does not hear joins it, so the answers reach it. `re` names
  the message it answers and `supersedes` one of this peer's
  own it replaces, each by its id or short id; a send naming
  an id nobody has, or another peer's message to replace, is
  refused.
- `mesh_read`: the latest messages this peer hears, and what
  it sent, for catching up after a reload or a compaction, or
  for reading a glance in full. Under each message it sent, it
  says which peers have it and which not yet, and under each
  one withdrawn, what replaced it.
- `mesh_join`, `mesh_leave` and `mesh_groups`: the groups this
  peer is in, and who is in each. `mesh_groups` also lists the
  leases of the peers still there. A bare name joins a peer's
  home group when some peer goes by it, and a named group
  otherwise; joining a group nobody is in makes it.
  `mesh_join` with `invite` brings other peers in without
  asking: each is sent a message to its home group carrying
  the group, joins on receipt, and may leave.
- `mesh_stop`: stop a peer reaching this one, or with `lift`,
  lift that stop. The stopped peer is told, with why.

## Context, Not a Prompt

A message never keeps a finished run going, and starts a turn
only for what an idle peer has to do something about (see
Act and Wake below), since otherwise its sender waits until
the person next speaks. While the agent works, pi holds what arrives and
appends it once the current step's tool results are in, so the
model reads it at its next call and carries on. While the
session is idle, it is appended with no turn, and the model
reads it when the person next speaks. What a peer catches up
on at start never starts a turn.

## Attention, Never None

Most of what goes to `#all` is one peer's progress on its own
work, and carried in full in every other peer's context it is
spent on what they will never act on. So each message to a
group is judged against what the receiving peer works on: its
quest's title and summary, the repositories its trees are in,
and its groups.

- **Note:** in full, with what its intent asks. For what is
  sent to this peer, a hold, and what is about this peer's
  work or the whole machine.
- **Glance:** another peer's own business. Shown on screen as
  it arrives, and handed to the model as one line with its
  next turn: at the end of the current step while it runs, or
  at the start of its next run while it is idle, or carried
  along with the next message noted in full. A digest spells
  out six and counts the rest, each cut to 160 characters.
  Glances survive a reload: each delivery records which it
  carried.
- **Act:** a note that starts a turn once the mesh settles,
  for an idle peer: a finding sent to it, or a question to a
  group about its work. It waits 30 seconds and up to 30 more,
  the extra different for each session so peers hearing one
  message do not start at once, and what arrives meanwhile
  goes in the same turn. A group's question another peer has
  answered by then is noted instead. A run that starts first,
  from the person or a wake, takes it along.
- **Wake:** a note that starts a turn at once, for a question
  sent to this idle peer or answering one it sent.

An fyi or a hold never starts a turn; neither asks an idle
peer to do anything. A withdrawal is noted by every peer that
heard what it withdraws, and a glance of that not yet handed
over is taken back.

The judging is done by a classifier model when one is to hand:
the first of TypeSafe's Jev models with credentials, or the one
`PI_MESH_CLASSIFIER` names as `provider/model`. It takes well
under a second, and only a judgement of "another peer's" at 0.6
or more makes a glance. With no classifier,
`PI_MESH_CLASSIFIER=off`, a failed call or one slower than
2.5 s, a message is noted. A message that names this peer or
something it owns is about its work without asking the
classifier at all.

## Damping

What a message is worth is held to what the receiving peer can
afford, so no sender and no conversation wears it out:

- **Turns:** the mesh starts at most 12 turns of a peer an
  hour, and at most 6 for any one sender.
- **Depth:** an answer more than 4 deep in its thread never
  starts a turn.
- **Repeats:** what a sender already said, word for word,
  within the hour, is a glance.

A damped message is never dropped: one that would have started
a turn is noted instead. The model is never told; the screen
says what was held back. The hour survives a reload, read back
from the session's own deliveries.

## Stop

Skynet's annals end on a stop that went unheard: a person sent
six messages in ten seconds wrote "please stop", and the fleet
carried on, because the side that listened had filtered her
out. So a stop is the receiver's, and the receiver's own mesh
enforces it, whatever harness the sender runs:

- **Glance:** what the stopped peer sends reaches the stopper
  as a glance, whatever its intent and wherever it went: never
  in full, never a turn, and never an invitation taken. An act
  already waiting when the stop is set becomes a glance too.
  Still a line, never nothing, so the stopper knows what it is
  not hearing; `mesh_read` has the rest.
- **Refused:** the stopped peer's sends to the stopper's home
  group are refused, and a send to a shared group says the
  stopper sees it as one line only.
- **Kept:** a stop lives in the stopper's presence, so it
  survives a reload, and names the stopped peer's session, so
  it follows that peer to a new quest's address.

Only the stopper lifts it, and nothing lifts it on a clock.
Unlike damping, the stop is said to both models: it is the
receiver's own choice, and the sender has to change what it
does.

## Leases

The swarm's holds mattered "as presence more than as a gate":
a peer reaching for what another held was told who, since
when and what, once, and went ahead beside it if it reached
again, while the holder heard. Skynet's bots, racing on one
question, found the same cause at twice the cost. So a lease
says what a peer is doing, the mesh tells those involved when
two overlap, and nothing waits to be granted one. The harness
takes most of them itself, since agents say what they are
doing only when it is the easy thing:

- **change:** each `edit` and `write` claims its file, named
  by repository and path, so two worktrees of one repository
  overlap. A peer reaching for a file another peer still there
  is changing is stopped once, with who, since when and their
  work, and the holder is sent an fyi; reaching again goes
  ahead beside them. The holder itself is never stopped. It
  lapses when the run ends, or ten minutes after the last edit.
- **answer:** a turn claims the questions it carries, so a
  group's question another peer has a turn for is only noted,
  "being answered by" that peer. It lapses with the run.
- **hold:** a hold sent claims what it holds, until its sender
  answers (`re`) or replaces (`supersedes`) it, or for two
  hours at most.
- **wait:** answering another peer's hold says this peer waits
  on it, so the holder sees what waits. When the holder answers
  or replaces it (a hold replacing it moves the wait to the new
  one), when the holder has ended, or when it has stood two
  hours, the waiting peer is handed the hold back with how it
  ended: a turn when idle, a note mid-run. Ends settle as acts
  do, so peers held by one hold do not all carry on at once.
  Only while it waits does a peer check, once a minute, that
  the holder is still there.
- **heavy:** any extension claims heavy work for this peer by
  emitting `mesh:lease:v1` on pi's bus, with
  `{ take: { subject, why?, ms? } }` or `{ release: subject }`;
  the subject names the kind of work. It lasts an hour unless
  `ms` says otherwise, and two hours at most. Starting heavy
  work others still there are running tells both sides, once.

Every lease also lapses when its holder is gone, which is asked
of the machine (see Who Is Still There). Holds and waits
outlive a reload; what a run claimed does not.

## Intents

- **hold:** do not start what it names until its sender says
  the hold is over. If it holds up work of this peer's, or this
  peer cannot hold, answer it, saying what; otherwise no reply.
- **question:** answer its sender, briefly.
- **finding:** for whoever owns what it is about, to note in
  their plan or journal. No reply.
- **fyi:** context only. No reply and no action.

A message with no intent, or one this version does not know,
is an fyi. Only what changes what another peer should do, or
concerns something it owns, is worth sending; progress,
acknowledgements and thanks are not.

## Where the Mesh Lives

Under `$XDG_STATE_HOME/pi/agentic-harness.pi/mesh-workflow/`:

- `messages/`: one JSON file per message, written to a
  dot-file and renamed into place, and watched with
  `fs.watch`. The envelope is
  `{ v, id, at, from, to, intent, text, pid }`, with `re`,
  `supersedes` and `invite` when they apply; a reader ignores
  fields it does not know. A `.read-<address>` marker
  per peer records the last message it was handed, so a reload
  catches up on what arrived while it was away; a peer that
  has never read catches up on the last hour.
- `presence/`: one file per peer, by session id, so its groups
  survive a reload and a restore. It is written when something
  in it changes (the quest, the groups, a run starting or
  ending), never on a clock.
- `leases/`: one file per peer, by session id, holding its
  current leases, so each peer writes only its own. It is
  rewritten when a lease is taken, given up, or renewed by a
  minute or more, and taken away when the peer holds none.

## Who Is Still There

A presence names the process holding it (pid, start time and
boot), and the core's process module says whether that process
still runs, so a new process wearing an old pid is not taken
for the peer. It is the answer the fleet sweep and review
leases give too. There is no heartbeat: Skynet's showed a timer
becomes pressure to post, and one died unnoticed for an hour
and forty-six minutes. A pi holds one session at a time, so of
the presences one process holds, only its latest is there. A
presence naming no process (an old membership) cannot be
judged and counts as there, since telling a sender a peer is
gone when it is not costs the message, and the reverse a line.
Ended peers are left out of `mesh_groups` and of who a message
goes to, and named when addressed; their presence is kept, so a
restored session is back in its groups.

A peer has a message once its read marker passes it, which is
when it is handed to the peer's model, at whatever attention.
A pi that keeps no session, such as a reload's load check,
stays off the mesh.

## The Legacy Mailbox

Sessions keep the harness they started with until they reload,
so for a while some still speak the mailbox this replaced, in
`~/.local/state/pi-mailbox`. `lib/mesh/legacy.ts` bridges the
two at the edge: every message is mirrored there in the old
shape under the same id, old mail is read as messages, each
peer's presence is kept there as an old membership, and old
memberships count as peers. A peer's first start takes the
channels its old membership listed as its groups, and the old
read markers, so nothing is handed over twice. It is deleted
once no session is left on the old harness.

## Not Yet

- Messages, markers and presence are never expired, nor the
  lease files of peers that ended holding a hold or a wait;
  their leases lapse by the clock all the same.
- Heavy work is leased only where something emits the lease
  event; nothing on the machine does yet.
- A change lease covers files, not a pull request in progress.
- An old membership names no process, so a session that ended
  on the old harness still counts as there until legacy.ts
  goes.
- A stop is set with `mesh_stop`, not yet read from plain
  words such as "please stop".
- Damping has no floor: nothing wakes a peer that rests too
  early.
