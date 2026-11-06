# Park Workflow

Ends a session left idle, so it holds no memory while it waits, and
leaves it to its holder to start it again when something needs it.

## Why

On 6 November 76 sessions held 45 GB of a 62 GB machine, and the 27
idle for over an hour held 14.3 GB of it. A session with a log under
8 MB still held a median of 469 MB: most of an idle session is pi and
its extensions, which a rollover can't give back. Only ending the
process does.

## When

A session parks once it has been idle past the time the switch sets,
and only while nothing of its own is still out:

- no run, retry or queued continuation, and no messages waiting for it;
- no background job running or waiting to say its result;
- no prompt open for its person, and nothing typed and unsent;
- no peer waiting on a hold it sent.

Idle counts from the last thing that happened in it: a prompt typed,
a run starting or ending, a prompt opening or closing.

## Turning It On

It is off until one of these turns it on:

- **The switch,** at
  `~/.local/state/pi/agentic-harness.pi/park-workflow/switch` (under
  `XDG_STATE_HOME`), read every minute. A line `on` parks every
  session after an hour idle. A line holding a session's id parks
  that one after two minutes, to prove parking on one session.
- **`PI_PARK=on`,** read at start, as the line `on` does.

`PI_PARK=off` keeps a session out, whatever the switch says. A
session parks only when a holder keeps it and has said where it
watches for the wake (`MYCELIUM_WAKE`), since a pi with nobody to
start it again has simply ended. It also has to wake into itself: a
holder that takes a restart (`MYCELIUM_AGAIN`) is given
`pi --session <its log>`, and under one that takes none it parks
only when pi was started on this session and nothing else, since the
launcher starts sessions as a bare `pi` or with a first prompt, and a
prompt given again would be sent again. Its log has to be written,
which pi does at its first answer, and pi must have been started with
no flag that restart would drop, such as `-e`. And the holder's
record has to name this very process, since a pi run through a shell
would exit to the shell's prompt rather than to its holder.

## What Happens

1. The mesh says `parked` in the session's presence. Senders take a
   parked peer as there while its marker stands, so what they send
   it rests on disk until it starts again, as between runs.
2. It writes its marker,
   `park-workflow/parked/<session-id>.json`, naming its log, its
   folder, its addresses, its quest, when it parked and, as `wake`,
   the file its holder wakes it on.
3. pi shuts down as `/quit` would, leaves a line in its window saying
   it is parked and that a key or a message wakes it, and exits with
   code 75 (EX_TEMPFAIL), which tells its holder this is a park, not
   an end.

A message that would give the parked peer a turn (a question or hold
sent to it, an answer to it, a pivot) makes its sender write the
message's id to the marker's `wake` file. The holder looks once a
second, deletes the file and starts the `pi --session` command in the
same window; a key typed in the window wakes it too. The session
deletes its marker as it starts.
