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
- **Yield:** a peer leaving its quest's address to another live
  peer that already signs with it, and signing with its session
  id's eight characters until that peer ends (see Who Is Still
  There).
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
  join to follow it. `#machine` (which `#all` still names) is
  the machine's group, and takes only holds and the answers
  that end them: a question, finding or fyi sent there is
  refused with where to send it, and one the mesh routes there
  goes to the sender's own work's groups. On 2026-10-25 the
  Karst and walgit sessions heard the mission's progress and
  questions in `#all`, none of it their work. Named
  groups (`#harness`, `#optimus/power`) nest: a member of
  `#optimus/power` also hears `#optimus`.
- **Realm:** a session's mesh is its realm's (see
  `lib/internal/realm.ts`), and a machine in two realms keeps
  two meshes that share nothing, with one exception. A hold
  sent to `#machine` also reaches each other realm's
  `#machine`, from `MACHINE`, in one fixed sentence holding
  none of the sender's words. It ends there in fixed words
  too, when its holder answers or replaces it, or the person
  ends it, since a switch or a reboot takes every realm's
  sessions alike (`lib/mesh/crossing.ts`).
- **Scope:** a group a peer is in because of its work rather
  than because it joined: its quest's, named down the parent
  chain from the root (`#quest/5gv2ah/luq49e`), each
  repository's its work is in (`#repo/agentic-harness-pi`),
  and each orchestration's it is in
  (`#orchestration/wcjqsg`). A message to `#quest/5gv2ah`
  reaches every peer on that quest or under it. Scopes follow
  the work and are not left while it is there.
- **Orchestration:** a quest marked `orchestrator: true` (the
  quest tool's `orchestrate`) is played by the session with it
  loaded, which orchestrates every quest below it up to the
  next marked one. Those sessions are in
  `#orchestration/<address>`, and their presence names it as
  `orchestratedBy`; `to: orchestrator` reaches it without its
  address. The tree is walked on the quest side; the mesh reads
  only presence. Within a mission, an unaddressed message now
  usually goes to the orchestration's group, since another
  peer is nearly always in it: the same reach `#quest/<root>`
  had. When a quest or document is concluded or retired, the
  mesh tells the session's orchestrator itself, one fyi line
  quoting what the quest tool answered, heard over pi's bus
  (`lib/internal/quest/concluded.ts`).
- **Joined:** the groups a peer chose, kept across a reload.
- **Presence:** what a peer publishes about itself: its
  addresses, its groups, what it works on and what it owns,
  whether it is mid-run, what it waits on its person for, and
  the process holding it. Its `state` says the same for the
  desktop in one word: `listening` when idle, `busy` mid-run
  (with `since`, when the run began, and `step`, the tool it
  runs, said at most every 30 seconds so the watched folder
  is not woken on every call), `waiting` when idle with a
  want standing, or `paused` when its person paused it, over
  all the rest.
- **Want:** what a peer waits on its person for: a question
  it asked, an approval it is held at, an unattended run
  that ended blocked, or something only they can do, said
  with `mesh_wait`.
- **Liveness:** whether a peer is still there, asked of the
  machine through the process its presence names.
- **Present:** a session's one connection to its machine's
  mycelium node, held open while its process runs, so the
  node hears it end the moment it does, a crash included. A
  reload keeps it; `--no-session` runs make none.
- **Attention:** what a message gets from the peer it reaches,
  decided by that peer and never none: a glance, a note, an
  act or a turn.
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
- **Hand:** a fleet's subagent, on the mesh only as the hands
  of the peer that started it: what it claims is that peer's,
  and it hears only the holds that reach that peer.
- **Retention:** how long the mesh keeps what it holds before
  it lets go.
- **Routing:** the groups the mesh picks for a message whose
  sender named none.
- **Transport:** where messages travel and rest.

## Tools

- `mesh_send`: send a message with an intent to the groups
  named in `to`, or, with `to` left out, to those routing
  picks (see Routing). It says which peers the message goes
  to, which addressed peers have ended or wait on their
  person, and which named groups nobody else is in yet. An
  address no session in this realm goes by, there or ended,
  is left out and said, and a send left with nowhere to go is
  refused, since realms are kept apart and nobody would read
  it; an answer still goes to whoever wrote what it answers.
  A peer
  reads what it writes to: sending to a named group it does
  not hear joins it, so the answers reach it. `re` names the
  message it answers and `supersedes` one of this peer's own
  it replaces, each by its id or short id. With `re` left out,
  a message other than a hold answers the one question this
  peer's run took up that was asked by a peer it goes to, or
  in a group it goes to, and says so; with two such questions
  it answers neither. An answer that names nothing reads to
  every other peer as no answer, so each goes on to answer the
  question too. A send is never
  refused for how it was written: an id nobody has, another
  peer's message to replace, or what cannot be a group is left
  out and said. The one send refused is to the home of a peer
  that stopped this one (see Stop).
- `mesh_read`: the latest messages this peer hears, and what
  it sent, for catching up after a reload or a compaction, or
  for reading a glance in full. Under each message it sent, it
  says which peers have it and which not yet, and under each
  one withdrawn, what replaced it. Under each question it
  asked, it says who answered and in which message, who is
  answering, or for how long it has gone unanswered. It keeps
  the newest that fit in 12 KB, at most 50, and names the
  oldest shown, so `before` with that id reads on.
- `mesh_join`, `mesh_leave` and `mesh_groups`: the groups this
  peer is in, and who is in each. `mesh_groups` also lists
  each other peer still there, one line each, saying whether
  it is busy or idle and what it works on, and the leases of
  the peers still there. A bare name joins a peer's
  home group when some peer goes by it, and a named group
  otherwise; joining a group nobody is in makes it. A join
  answers with the group's last ten messages, a line each, so
  a peer starts from where its talk stands.
  `mesh_join` with `invite` brings other peers in without
  asking: each is sent a message to its home group carrying
  the group, joins on receipt, and may leave.
- `mesh_stop`: stop a peer reaching this one, or with `lift`,
  lift that stop. The stopped peer is told, with why.
- `mesh_wait`: say that this session's quest has something
  waiting on the person that only they can do, or with `done`
  that it no longer waits. It is kept in
  `~/.local/state/mission/waiting/<ADDRESS>.json` (version 2), the
  file the launcher's Needs You reads, so it outlives the session;
  presence mirrors what is ready as an `action` want. Every item
  says how it will be known done (`doneWhen`: a check, a signal
  such as `boot` or `signin:google`, or `by: person`), and may say
  what it waits for first (`readyWhen`). The desktop's daemon
  writes what it found in `~/.local/state/mission/verdicts.json`;
  a session applies those as it starts and as each run ends, so an
  item clears itself. Sealing a quest removes its file.

## Context, Not a Prompt

A message never keeps a finished run going, and starts a turn
only for what an idle peer has to do something about (see
Act and Turn below), since otherwise its sender waits until
the person next speaks. While the agent works, pi holds what arrives and
appends it once the current step's tool results are in, so the
model reads it at its next call and carries on. While the
session is idle, it is appended with no turn, and the model
reads it when the person next speaks. What a peer catches up
on at start never starts a turn.

Every delivery ends by saying what to do with it: act now on a
question or a hold put to this peer, tell the person at once
anything they must act on (in the reply when talking with them,
to the quest's orchestrator as a question otherwise), and take
the rest as context, with no acknowledgement. It once said only
that messages were context, not a task, and models took that as
leave to sit on questions and on what the person had to do.

## Attention, Never None

Most of what went to `#all` was one peer's progress on its own
work, and carried in full in every other peer's context it is
spent on what they will never act on. So each message to a
group is judged against what the receiving peer works on: its
quest's title and summary, the repositories its trees are in,
and its groups.

- **Note:** in full to the model, with what its intent asks.
  For what is sent to this peer, a hold, and what is about
  this peer's work or the whole machine. On screen it is one
  line a message, `※ mesh: WCJQSG · finding · <how it opens>`,
  naming the group only when it went to one, and in full once
  expanded, so a session waiting its turn keeps its own work
  in sight.
- **Glance:** another peer's own business. Nothing on screen;
  handed to the model as one line with its next turn: at the end of the current step while it runs, or
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
  goes in the same turn. A question to the machine that
  another peer has answered by then is noted instead, and so
  is one another peer is answering, until that peer lets it
  go. When its run
  ends, or it does, with no answer sent, the question waits to
  act here after all, up to an hour after it was asked. A run
  that starts first,
  from the person or a turn, takes it along.
- **Turn:** a note that starts a turn at once (called a wake
  until 2026-10-25, when wake read as resuming from sleep). That covers a
  question or hold put to this peer, by its address or as one
  of each a question went to, and any answer to a question it
  asked, whether the peer is idle or busy. It also covers an
  answer to one it sent, while idle. A busy peer
  has it steered into the run under way, read after the
  current tool, since a note waits for the model's current call
  to end, and when that call was the run's last, it waited for
  the person to speak. A question sent to several peers, or to
  a named group, asks each of them, and another's answer is
  never this peer's, since on 2026-10-25 a group question that
  gave each member its own part was silenced by the first
  reply.

An fyi never starts a turn, nor does a hold that wasn't put to
this peer; neither asks an idle peer to do anything. The one
exception is an answer to a question this peer asked, which
it is waiting on however the answer was sent. What a peer
catches up on as it starts is noted, since it rides the first
prompt.

A question put to this peer that it hasn't answered (no message
from it with `re` set to the question) is asked again five
minutes after it was last handed over, with a turn, at most
twice and within the hour. The peer that asked it of named
addresses is told once, on screen and in a note, which of them
hasn't answered after five minutes. Both are kept in memory, so
a reload starts them again ([`lib/mesh/owed.ts`](../../lib/mesh/owed.ts)).
`mesh_read` with `unanswered` lists every question on the mesh,
from any peer, still waiting on a peer it named in the last two
hours, oldest first with its age, and says which of those peers
have gone. An answer anywhere in a question's thread counts, and an
asker's own follow-up question closes the one it answers. An answer
that names no group goes back to whoever asked ([`lib/mesh/unanswered.ts`](../../lib/mesh/unanswered.ts)).

An fyi other than an awaited answer, more than an hour old when it
reaches a peer, as after a reload, is a glance wherever it
went, since what it told has moved on (Skynet's register gives
an fyi an hour). So is a hold more than two hours old, the
longest a hold stands, since it no longer holds anything. A
message from before today says the date it was sent beside
the time. A withdrawal is noted by every peer that
heard what it withdraws, and a glance of that not yet handed
over is taken back.

The judging is done by a classifier model when one is to hand:
the first of TypeSafe's Jev models with credentials, or the one
`PI_MESH_CLASSIFIER` names as `provider/model`. It takes well
under a second, and only a judgement of "another peer's" at 0.6
or more makes a glance. With no classifier,
`PI_MESH_CLASSIFIER=off`, a failed call or one slower than
2.5 s, a message is noted. A message that names this peer,
something it owns or the path of a file it is changing is about
its work without asking the classifier at all.

While a peer is changing files, the classifier is shown them,
latest first and at most twelve, and asked about what the peer
changes now as well as what it works on. That is what tells one
peer's merge on a shared group from another's: shown the files,
Jev put four unrelated "merging core" fyis at 0.73 to 0.81
"another peer's", where without them it stayed under 0.6 and
noted each in full.

## Damping

What a message is worth is held to what the receiving peer can
afford, so no sender and no conversation wears it out:

- **Questions:** none of these limits holds back a question
  that would start a turn: on 2026-10-25 one put to an idle
  peer sat unstarted as too deep in its thread while Joel
  watched it wait. A hold put to the peer passes depth too.
- **Turns:** the mesh starts at most 12 turns of a peer an
  hour, and at most 6 for any one sender.
- **Depth:** any other answer more than 4 deep in its thread
  never starts a turn.
- **Repeats:** what a sender already said, word for word,
  within the hour, is a glance. The same message handed again,
  as a question let go comes back, is no repeat.
- **News:** once a sender has had 10 of its messages handed
  over in full within the hour, its next fyi is a glance,
  since a note read mid-run costs as much reading as a turn.
- **Catch-up:** a peer starting with more than 20 messages to
  take in is handed in full only the newest 20, with whatever
  is addressed to it, answers it or holds; the rest are
  glances, so a session back from a night away does not start
  under a night of other peers' news.
- **Awaited:** an answer to a question the peer asked starts
  its turn whatever the hour has spent, and the turn still
  counts. Depth and repeats still hold it back, so two peers
  cannot ask and answer each other past them. Nor is an
  awaited fyi glanced for its sender's news.
- **Addressed:** a question or hold put to this peer starts its
  turn past the hour's turns in the same way, and the turn
  still counts. The orchestrator, whom every quest asks, spent
  its twelve early on 2026-10-25 and left questions waiting for
  the person.

A damped message is never dropped: one that would have started
a turn is noted instead. The model is never told; the screen
says what was held back. The hour survives a reload, read back
from the session's own deliveries.

## Stop

Skynet's annals end on an objection that went unheard. One
morning an engineer got six messages within ten seconds and
answered that the list was too much. The fleet's night filter,
never lifted, appears to have held that, and four minutes later
it edited a reply and uploaded a file anyway. Her "please stop"
never reached it either; the operator stopped it by hand. It
listened as at night while it spoke as by day, and the
requirements written after say a plain objection sets a stop
toward whoever made it. So a stop is the receiver's, and the
receiver's own mesh enforces it, whatever harness the sender
runs:

- **Glance:** what the stopped peer sends reaches the stopper
  as a glance, whatever its intent and wherever it went: never
  in full, never a turn, and never an invitation taken. An act
  already waiting when the stop is set becomes a glance too.
  Still a line, never nothing, so the stopper knows what it is
  not hearing; `mesh_read` has the rest.
- **Refused:** the stopped peer's sends to the stopper's home
  group are refused (a send naming other groups too goes to
  those alone), routing never picks the stopper, and a send to
  a shared group says the stopper sees it as one line only.
  The stopper is told its stop takes in the stopped peer's
  answers to its own questions too.
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
again, while the holder heard. Set racing on one jammed merge
lane, Skynet and another team's bot found the same cause
minutes apart, at twice the cost. So a lease
says what a peer is doing, the mesh tells those involved when
two overlap, and nothing waits to be granted one. The harness
takes most of them itself, since agents say what they are
doing only when it is the easy thing:

- **change:** each `edit` and `write` claims its file, named
  by repository and path, so two worktrees of one repository
  overlap. A peer reaching for a file another peer still there
  is changing is stopped once, with who, since when and their
  work, and the holder is sent an fyi; reaching again goes
  ahead beside them. The holder hears of it once an hour from
  this peer, whichever of its processes or hands reaches, and
  however often it retakes its own claim (`told/`). The holder
  itself is never stopped. It
  lapses when the run ends, or ten minutes after the last edit.
  A `bash` call running git that rewrites a checkout's files
  (`checkout` or `switch` to another commit, `reset --hard`,
  `stash`, `rebase`, `merge`, `pull`, `restore`, `clean -f`,
  `cherry-pick`, `revert`, `am`) claims the whole checkout, by
  its path, so two worktrees are two checkouts. While another
  peer still there is changing files in that checkout, it is
  stopped once with who and what, and each such peer is sent
  an fyi; running it again goes ahead. An edit in a checkout
  another peer rewrote in its run is stopped once the same
  way, since the files may not be what the editor read. One
  shared checkout is where a hard reset or a stash takes
  another peer's edits with it.
- **answer:** a turn claims the questions it carries, so a
  machine-wide question another peer has a turn for is only noted,
  "being answered by" that peer. Each turn's end renews it, so
  a long answer is not taken for one let go. It lapses with
  the run.
- **hold:** a hold sent claims what it holds, until its sender
  answers (`re`) or replaces (`supersedes`) it, or for two
  hours at most. No lease outlives the boot it was taken in:
  a session restored after a reboot lets go of what it
  claimed before, and a hand is not held by a hold from then.
- **wait:** answering another peer's hold says this peer waits
  on it, so the holder sees what waits. When the holder answers
  or replaces it (a hold replacing it moves the wait to the new
  one), when the holder has ended, when the machine has
  restarted since it was sent (a restored holder answers at
  its old address, so it is not gone), or when it has stood
  two hours, or when another peer ends it on the person's word
  (`endsHold`, which the `mesh-end-hold` guard asks the person
  to confirm, and which waits on nothing), the waiting peer is
  handed the hold back with how it
  ended: a turn when idle, a note mid-run. Only a hold its
  holder or the person said was over comes with leave to carry
  on; one that lapsed, outlived its boot or lost its holder
  says nobody said so, and to check
  that what it named is free first. Ends settle as acts
  do, so peers held by one hold do not all carry on at once.
  Only while it waits does a peer check, once a minute, that
  the holder is still there. While a live peer waits, the
  holder's heavy work, and its hands', goes first in its class
  in the machine queue, since finishing it is what lets the
  waiting peers carry on; `queue.json` marks such a job
  `awaited`.
  This is how a machine-wide pause, a reboot included, hands
  work back: the holder asks each peer to answer its hold once
  parked, and answers the hold itself when work may resume.
  Waits are kept on disk under the session's id and an end is
  known by the holder's address, so a session restored after a
  reboot is handed its turn, and one that ended while it was
  down is found as it starts. A peer back before its holder
  finds the holder ended, and carries on checking first. A
  question or an fyi hands nothing back, so a pause sent as one
  leaves sessions parked.
- **heavy:** a `bash` call running heavy work, as the machine
  queue's own map reads it (`kindOf` in
  lib/internal/priority/queue.ts: a VM test, a VM check, a
  benchmark or a build), claims that kind of work until the
  call answers. So a hold stops exactly what the queue would
  queue: a step that only looks for the work, as `pgrep
  qemu-system-x86` does, or work named in quotes or a heredoc,
  claims nothing. One handed
  to a job runs on past its answer, until the job says it has
  ended (`jobs:finished:v1`). Any extension can claim heavy work too, by
  emitting `mesh:lease:v1` on pi's bus with
  `{ take: { subject, why?, ms? } }` or `{ release: subject }`;
  the subject names the kind of work. It lasts an hour unless
  `ms` says otherwise, and two hours at most, and ends with the
  session. A reload is not the session ending: its jobs run on
  through it, so the claims of calls handed to one stay, and the
  runtime the reload starts lets each go when its job ends, even
  one that ended before that runtime had started. Starting heavy work others still there are running
  tells both sides, once, unless the machine's queue is kept
  (priority-workflow's `queue.json` written in the last two
  minutes): then the queue gives each its turn by the room left,
  and `mesh_groups` says what each peer runs, or waits for at
  which place, from `queue.json` in place of these claims, since
  a claim says only that a command started.

Every lease also lapses when its holder is gone, which is asked
of the machine (see Who Is Still There). Holds and waits
outlive a reload; what a run claimed does not.

## A Session's Hands

A subagent is a worker with one job, answering to the session
that started it. As a peer of its own it would be handed the
machine's chatter mid-job and reached by senders who should
reach its parent. Kept off the mesh, it could not hear a hold,
and its builds and edits were nobody's on the board. Skynet's
parallel cargo builds took its laptop to a load of 192 on 16
cores. So a subagent is its parent's hands:

- **No address of its own:** it has no presence, no tools, and
  nothing is sent to it or by it.
- **Its claims are its parent's:** its file changes, checkout
  rewrites and heavy work are leased under the parent, marked "by a subagent",
  so others are told of an overlap and `mesh_groups` lists the
  claim beside the parent's own. A parent's hands never
  overlap with it or with each other.
- **Holds reach it:** a subagent starts with the holds standing
  that reach its parent, hears as each begins and ends, and is
  stopped once before heavy work while one stands, with who
  holds it and until when. Running the command again goes
  ahead.
- **It speaks through its parent:** anything for other peers
  goes in its answer, and the parent decides what to send.

A peer names its session in its environment
(`PI_MESH_SESSION`), which the fleet passes to every subagent,
nested ones included. The mesh registers `hand.ts` with the
fleet (`subagent:register-default-extension:v1`, or through
`subagent:ready:v1` when the fleet loaded first), so isolated
subagents load it too. A subagent's claims are not tied to a
process the machine can be asked about, so one killed mid-build
leaves its heavy claim standing until the claim's hour is up.

## Routing

The sender knows what a message is about, so it chooses who
hears; but a sender made to name a group before it may speak
often names the wrong one or none, and a refused message is
one nobody hears. So a message with no `to` is routed, by the
first of these that answers:

- **references:** the named groups the text mentions as
  people write them (`core.nix` for `#repo/core-nix`, "the
  stick" for `#stick`), a group a broader one it mentions
  already reaches left out, and the home of each peer it names
  by address or by something it owns that those do not reach.
  A name shorter than four letters is too common a word to
  count.
- **the classifier:** asked to pick, among the named groups
  other peers are in and the whole machine, the one whose work
  the message is about, and trusted only at 0.8 or more, or
  0.95 for the whole machine, which costs every peer a line.
  Asked live about thirteen messages, the five groups it
  picked at 0.8 or more were all right and its wrong groups
  came at two in three or less; it gave the whole machine 0.97
  and 1.0 for two reboots, but 0.92 for "going to lunch".
- **a rule:** a hold holds the whole machine; anything else
  goes to this peer's scopes that another peer is in; failing
  those, to the nearest quest above this peer's own that
  another peer hears, since a subquest alone on its scope is
  still its parent's work; failing that, to this peer's own
  orchestration, quest or repository group, where it waits for
  whoever joins. Only a hold, or a message from a peer on no
  work at all, goes to the whole machine.

A peer that stopped the sender is never routed to. The sender
is told where the message went and why, so it can send again
naming the groups.

A message that opens by naming peers ("P9R1KI: may I", or
"@WCJQSG the schema") is for them, so it goes to their homes
alone, wherever it was sent and whether or not it named a
group. Sent to a group they share, every other member would
read it only to learn it was not theirs: on 22 October
questions meant for one session went to a design group of
five.
Two are left where they were sent: an answer, since the group
its question went to sees by it that the question is
answered, and a replacement, which goes wherever what it
replaces went. An opening that names anything but other
peers, as a sender signing its own message does, is not
read as an address.

## Intents

- **hold:** do not start what it names until its sender says
  the hold is over. If it holds up work of this peer's, or this
  peer cannot hold, answer it, saying what; otherwise no reply.
- **question:** answer its sender, briefly.
- **finding:** for whoever owns what it is about, saying what
  the sender checked it against; the owner checks it against
  the source, then notes it in their plan or journal. No reply.
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
  has never read catches up on the last hour. A peer watches
  before it catches up, so what lands between the two is not
  missed, and looks in the folder again once a minute and as
  each run ends for anything its watcher never reported, since
  the kernel drops watch events when its queue fills.
- `presence/`: one file per peer, by session id, so its groups
  survive a reload and a restore. It is written when something
  in it changes (the quest, the groups, a run starting or
  ending), never on a clock. Its `title` is the exact window
  title pi sets, so the desktop finds a peer's window by it
  rather than by parsing the title, which carries no address.
- `leases/`: one file per peer, by session id, holding its
  current leases, so each peer writes only its own. It is
  rewritten when a lease is taken, given up, or renewed by a
  minute or more, and taken away when the peer holds none.
- `told/`: one file per overlap a peer told another of, by
  teller, holder, kind and subject, so every process of the
  teller, its hands among them, sends that fyi once an hour.
  Files past their hour are removed as another is written.

A session with `PI_MESH=off` stays off the mesh altogether, as
one kept nowhere does: it joins no group, hears nothing and
claims nothing. A session on a small personal plan runs so, since
the machine's holds and questions could otherwise start turns on
its allowance.

## Steer

The person can speak to a session from outside its window, as
the launcher's Steer box does, through a folder per address
under `$XDG_STATE_HOME/pi/agentic-harness.pi/steer/`: a file
renamed into `steer/<ADDRESS>/` as `<unix-ms>-<random>.json`,
holding `{"text": "...", "at": "<ISO time>", "from": "joel"}`
(only `text` is needed), reaches the session going by that
address as the person's own message. That's a turn when idle,
and a steer into the run under way, read after its tool,
otherwise. It isn't a mesh message, since peers read those as
another agent's context. The session takes each file by
renaming it, so it's delivered once, and sets one with no text
aside as `.bad`. It settles which folders it watches at every
look, since a quest's address comes and goes with the quest
([`lib/mesh/steer.ts`](../../lib/mesh/steer.ts)).

A steer that also carries an `id` (letters, digits, `.`, `-`
and `_`, at most 64) opens a talk: what became of it goes, one
JSON line per change with its `at`, into
`steer/<ADDRESS>/replies/<id>.jsonl`, so the launcher can show
it as it goes and keep its history after the session ends. The
stages are `delivered` (with the person's words, `from` and
`sentAt`), `reading` (its step and how long, at most every 30
seconds), `replying` (the reply so far, at most every second),
then `replied` with the whole reply or `failed` with why: the
run was stopped or wrote nothing. A quest or document that ends
afterwards, before the next talk opens, adds `came`, such as
`{"stage": "came", "what": "plan concluded", "ref": "PLAN-..."}`.
An inbox keeps its talks for 90 days or its newest 500,
whichever keeps more, pruned as each opens
([`lib/mesh/talk.ts`](../../lib/mesh/talk.ts)).

A steer may instead carry an `act`, with no text needed
([`pausing.ts`](pausing.ts)):

- `stop` ends the run in progress at once; the session stays
  open and listening.
- `pause` lets the run finish the turn it is on, tools and
  all, then ends it. Until Resume, a talk or the person typing
  in the window, any other run that starts is ended as it
  starts, whatever started it, and mesh messages arrive
  without a turn. Presence says `paused`, and a reload keeps
  it.
- `resume` clears the pause and has the session carry on
  where it left off; with text, the text is the turn instead.

An ended run ends away mode on every session, so a Stop, or a
Pause landing mid-run, ends it too: pressing either says the
person is at the desk.

## Retention

Nothing on the mesh is a record anyone is owed, and kept for
ever every listing grows with the machine's history rather
than its present. So any peer, at most once an hour and off its
turn (as it starts, and as a run ends), lets go of:

- messages a week after they were sent, which outlives any
  hold, catch-up or thread a peer would still answer into;
- read markers whose peer has read nothing for that week;
- an ended peer's presence a day after it last changed, so
  senders are told it ended for a day and then forget it, or a
  week after when it stopped another peer, so a session
  restored within the week comes back with its stops;
- a peer's lease file once none of its leases stands;
- files a writer staged and never renamed into place.

`mesh_read` reads only the newest messages it shows.

## Who Is Still There

A presence names the process holding it (pid, start time and
boot), and the core's process module says whether that process
still runs, so a new process wearing an old pid is not taken
for the peer. It is the answer the fleet sweep and review
leases give too. Within one boot the presence's start in the
kernel's ticks decides, where the machine keeps them: core's
start time is wall-clock milliseconds, which suspends move, and
after a 100-cycle suspend soak it had moved four seconds, past
its two-second tolerance, so every peer read as ended. There is
no heartbeat: Skynet's showed a timer
becomes pressure to post, and one died unnoticed for an hour
and forty-six minutes. A pi holds one session at a time, so of
the presences one process holds, only its latest is there. A
presence naming no process, when the machine would not say
which holds it, cannot be judged and counts as there, since
telling a sender a peer is gone when it is not costs the
message, and the reverse a line. Ended peers are left out of
`mesh_groups` and of who a message goes to, and named when
addressed; their presence is kept for a day (see Retention), so
a session restored by then is back in its groups.

A session whose log rolls over into a fresh one (see the
rollover workflow) carries on as the same peer under a new
session id. The old log names its session as it goes, and the
fresh one takes that session's presence and leases as its own:
its addresses, including the old session id's eight
characters, the groups it joined, the stops it set, and the
holds and waits it stood on. The old presence is then
forgotten, so nobody else signs with those addresses and a
hold nobody has let go of does not read as its holder ending.

Two sessions can have one quest loaded at once, which happens
often, as when a second session is opened on it.
Both signing with its address, each took the other's messages
for its own and heard none, and one read marker served both.
So the address is one live peer's. A peer starting while
another live peer signs with it yields: it signs with its
session id's eight characters, and keeps its own read marker.
Two that took it at once settle by session id, the lower
keeping it, so neither flips back and forth. The holder is
told on the mesh and the one yielding is told in its session,
each asked to agree which part of the quest it takes, since two
sessions on one quest are how work gets done twice. Both still
hear the quest's group; its address reaches only the holder.
Who is still there is counted at start and once a minute, so a
peer takes the address back within a minute of its holder
ending, and a holder that ended never keeps it from anyone.

A peer has a message once its read marker passes it, which is
when it is handed to the peer's model, at whatever attention.
The marker never passes one still waiting to act, so a reload
in that minute hands it over at the next start instead of
losing it; what the session's own entries show it handed over
beside it is not handed over again.
A pi that keeps no session, such as a reload's load check,
stays off the mesh.

## What a Peer Waits On

A peer that has asked its person something, is held at an
approval, or ended an unattended run blocked can do nothing
until he answers, and its presence would say only that it is
idle. So while it waits, its presence carries `wants`:

```json
{ "kind": "question", "since": "2026-10-22T08:00:00.000Z", "said": "Which launcher?" }
```

`kind` is `question`, `approval` or `blocked`; `since` is when
it began waiting; `said` is what it asked or said, on one line
of at most 120 characters. Each kind stands until it is
settled, and while more than one stands, presence holds the
one that has stood longest. The field is absent when nothing
waits. The desktop reads it to mark a session that wants Joel;
a peer can read it, and `mesh_groups` lists it, so none is
waited on as though it were free.

The session says each want as it starts and ends, over the bus
(`session:wants:v1`, see `lib/internal/session/wants.ts`): a
panel left unanswered for five seconds, calls held while away,
an away run ended blocked, or a run ending on a question. A
want is never read back from a presence file, only heard from
the process that raised it, so a session restarted waits on
nothing. The mesh listens from the moment it loads and holds
what it heard until its peer is made, since a reload with a
panel still open says its wants again as the session starts.

What a session lands is its status, so presence keeps it
rather than leaving it to be sent. Each change merged through
`review_offer merge` and each plan item ticked with `quest tick`
is said over the bus (`session:landed:v1`, see
`lib/internal/session/landings.ts`), and presence carries the
newest five from the last day as `landings`:

```json
[{ "at": "2026-11-01T15:00:00.000Z", "ref": "agentic-harness.pi#920", "what": "Carry Background Jobs Across a Rollover" }]
```

`ref` names a change as `repo#number` or a plan item as
`DOCUMENT#item`; `what` is one line; an optional `person` says
what it means to the session's person. A ref landing again takes
the earlier one's place, and an unticked plan item is taken back
(`session:unlanded:v1`). Landings are read back from the
session's own presence at start, and from the one it rolled over
from, so they outlast a reload and a rollover. An fyi to the
session heading an orchestration that names one of its sender's
landings, by `#number`, `PR number` or the document's id, reaches
it as a glance unless it answers that session: the orchestrator
can read it in presence instead.

## Not Yet

- A change lease covers files, not a pull request in progress.
- A stop is set with `mesh_stop`, not yet read from plain
  words such as "please stop".
- Damping has no floor: nothing gives a turn to a peer that rests too
  early.
