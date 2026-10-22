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
  stamped by the mesh with an id and a time.
- **Intent:** what a message asks of whoever it reaches: hold,
  question, finding or fyi.
- **Group:** where every message goes. There are no direct
  messages: a peer is reached through its home group, written
  as its address (`P9R1KI`, or `@P9R1KI`), which anyone may
  join to follow it. `#all` is the machine's group. Named
  groups (`#harness`, `#optimus/power`) are joined for the
  work a peer does, and nest: a member of `#optimus/power`
  also hears `#optimus`.
- **Presence:** what a peer publishes about itself: its
  addresses, its groups, what it works on and what it owns.
- **Attention:** what a message gets from the peer it reaches,
  decided by that peer and never none: a glance, a note or a
  wake.
- **Transport:** where messages travel and rest.

## Tools

- `mesh_send`: send a message with an intent to one or more
  groups. It says which peers the message reaches and which
  addresses nobody goes by, and refuses a named group nobody
  else is in.
- `mesh_read`: the latest messages this peer hears, and what
  it sent, for catching up after a reload or a compaction, or
  for reading a glance in full.
- `mesh_join`, `mesh_leave` and `mesh_groups`: the groups this
  peer is in, and who is in each. A bare name joins a peer's
  home group when some peer goes by it, and a named group
  otherwise.

## Context, Not a Prompt

A message never keeps a finished run going, and starts a turn
only for a question this peer is the one to answer while it is
idle, since otherwise its sender waits until the person next
speaks. While the agent works, pi holds what arrives and
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
- **Wake:** a note that starts a turn, for a question this
  peer is the one to answer while it is idle.

The judging is done by a classifier model when one is to hand:
the first of TypeSafe's Jev models with credentials, or the one
`PI_MESH_CLASSIFIER` names as `provider/model`. It takes well
under a second, and only a judgement of "another peer's" at 0.6
or more makes a glance. With no classifier,
`PI_MESH_CLASSIFIER=off`, a failed call or one slower than
2.5 s, a message is noted, and a question that names this peer
or something it owns still wakes it while it is idle.

## Intents

- **hold:** do not start what it names until its sender says
  the hold is over. Reply only if already in the middle of it
  or unable to hold.
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
  `{ v, id, at, from, to, intent, text, pid }`; a reader
  ignores fields it does not know. A `.read-<address>` marker
  per peer records the last message it was handed, so a reload
  catches up on what arrived while it was away; a peer that
  has never read catches up on the last hour.
- `presence/`: one file per peer, by session id, so its groups
  survive a reload and a restore.

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

- Messages, markers and presence are never expired.
- There is no reply threading.
