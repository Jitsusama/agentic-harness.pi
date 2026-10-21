# Mail Workflow

Lets the pi sessions on one machine message each other
without typing into each other's terminals. Typing into a
terminal lands in whatever the person is typing, and can
answer a question or a gate left open on screen.

## Tools

- `mail_send`: send a message to sessions by name, or to
  `all`. A session is named by the last six letters of the
  quest it has loaded (`P9R1KI`), and also answers to older
  quests that list it and to the first eight characters of
  its session id.
- `mail_read`: the latest messages, for catching up after a
  reload or a compaction.

## Mail Is Context, Not a Prompt

Mail never starts a turn and never keeps a finished run
going. While the agent works, pi holds it and appends it
once the current step's tool results are in, so the model
reads it at its next call and carries on. While the session
is idle, it is appended with no turn, and the model reads it
when the person next speaks. It is shown on screen either
way.

Each delivery tells the model the mail is for awareness:
keep on with what it was doing, act only when the mail asks
it to hold or avoid something it is about to do, or asks it
a question, and then answer with `mail_send` and carry on.

## Where Mail Lives

One JSON file per message in `$XDG_STATE_HOME/pi-mailbox`
(`~/.local/state/pi-mailbox`), written to a dot-file and
renamed into place, and watched with `fs.watch`. A
`.read-<name>` marker per session records the last message
it was handed, so a reload or restart catches up on what
arrived while it was away; a session that has never read
catches up on the last hour.

## Not Yet

- Old mail and markers are never expired.
- Mail to a name no session has goes nowhere, silently.
- There is no reply threading.
