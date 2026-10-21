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

Mail never starts a turn and never keeps a finished run
going. While the agent works, pi holds it and appends it
once the current step's tool results are in, so the model
reads it at its next call and carries on. While the session
is idle, it is appended with no turn, and the model reads it
when the person next speaks. It is shown on screen either
way, and the model is told it needs no acknowledgement.

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
