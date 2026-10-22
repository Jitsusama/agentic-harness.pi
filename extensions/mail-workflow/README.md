# Mail Workflow

Lets the pi sessions on one machine message each other
without typing into each other's terminals. Typing into a
terminal lands in whatever the person is typing, and can
answer a question or a gate left open on screen.

## Tools

- `mail_send`: send a message, with a kind, to sessions by
  name, to channels, or to `all`. A session is named by the
  last six letters of the quest it has loaded (`P9R1KI`),
  and also answers to older quests that list it and to the
  first eight characters of its session id. It says which
  sessions the message reaches and which names nobody
  answers to, and refuses a channel nobody else is on.
- `mail_read`: the latest mail this session can hear, and
  what it sent, for catching up after a reload or a
  compaction.
- `mail_join`, `mail_leave` and `mail_channels`: the
  channels this session is on, and who is on each.

## Mail Is Context, Not a Prompt

Mail never keeps a finished run going, and starts a turn
only for a question this session is the one to answer while
it is idle, since otherwise its sender waits until the
person next speaks. While the agent works, pi holds mail and
appends it once the current step's tool results are in, so
the model reads it at its next call and carries on. While
the session is idle, other mail is appended with no turn,
and the model reads it when the person next speaks. Mail
caught up on at start never starts a turn. It is shown on
screen either way, and the model is told it needs no
acknowledgement.

## Only Where It Bears

Most mail to everyone is one session's progress on its own
work, and carried in every other session's context it is
spent on what they will never act on. So each mail to
everyone or to a channel is judged against what the
receiving session works on: its quest's title and summary,
the repositories its trees are in, and its channels.

- **Addressed by name, or a hold:** always delivered.
- **About this session's work, or the whole machine:**
  delivered.
- **Another session's own business:** shown on screen as
  passed by and kept out of the model's context. `mail_read`
  still lists it.

The judging is done by a classifier model when one is to
hand: the first of TypeSafe's Jev models with credentials,
or the one `PI_MAIL_CLASSIFIER` names as `provider/model`.
It takes well under a second, and only a judgement of
"another session's" at 0.6 or more keeps mail out. With no
classifier, `PI_MAIL_CLASSIFIER=off`, a failed call or one
slower than 2.5 s, mail is delivered as it always was, and a
question that names this session or something it owns still
starts a turn when it is idle.

## Kinds

Every mail says what it asks of whoever it reaches:

- **hold:** do not start what it names until its sender
  says the hold is over. Reply only if already in the
  middle of it or unable to hold.
- **question:** answer its sender, briefly.
- **finding:** for whoever owns what it is about, to note
  in their plan or journal. No reply.
- **fyi:** context only. No reply and no action.

Mail without a kind, or with one this version does not
know, is an fyi. Only what changes what another session
should do, or concerns something it owns, is worth sending;
progress, acknowledgements and thanks are not.

## Channels

Every session is on the global channel, which `all`
addresses; it is for what touches every session on the
machine, such as a reboot, a switch or heavy CPU. Named
channels (`#harness`, `#optimus`, `#optimus/power`) are
joined for the work a session does. They nest: a member of
`#optimus/power` also hears mail to `#optimus`. A sender
picks the narrowest audience that reaches everyone
affected.

A session's channels are kept by its pi session id, so they
survive a reload and a restore.

## Where Mail Lives

One JSON file per message in `$XDG_STATE_HOME/pi-mailbox`
(`~/.local/state/pi-mailbox`), written to a dot-file and
renamed into place, and watched with `fs.watch`. Each
session's channels and names are kept under `.members/`. A
`.read-<name>` marker per session records the last message
it was handed, so a reload or restart catches up on what
arrived while it was away; a session that has never read
catches up on the last hour.

## Not Yet

- Old mail, markers and memberships are never expired.
- There is no reply threading.
