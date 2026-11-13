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
and only while nothing of its own is still out. Idle counts from the
last message in its log, so a reload doesn't start it again; a mesh
note is no message. A session just woken from a park counts from its
waking, so a key that woke it keeps it up.

What must not be out:

- no run, retry or queued continuation, and no messages waiting for it;
- no background job running or waiting to say its result;
- no prompt open for its person, and nothing typed and unsent;
- no peer waiting on a hold it sent;
- for an orchestrator, no session it leads at work (listening, busy
  or waiting rather than parked or paused), since their findings and
  landings are its to pass on;
- and it must not be the session standing at the launcher's top
  (its quest's `stands-at-top`), which takes the person's lines and
  would make each wait for a wake.

Idle counts from the last thing that happened in it: a prompt typed,
a run starting or ending, a prompt opening or closing.

While one stays awake, it says why in
`park-workflow/awake/<session-id>.json` (`why` and `since`), rewritten
only when the reason changes and removed once it parks or ends. A
person's session with no holder to wake it says so there once, as it
starts. A note whose session has crashed stays until a reader checks
the session's presence, so read the two together.

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
`pi --session <its log>`, with the `--model`, `--models`,
`--provider` and `--thinking` flags pi was started with, and under
one that takes none it parks
only when pi was started on this session and nothing else, since the
launcher starts sessions as a bare `pi` or with a first prompt, and a
prompt given again would be sent again. Its log has to be written,
which pi does at its first answer, and pi must have been started with
no flag that restart would drop, such as `-e`. And the holder's
record has to name this very process, since a pi run through a shell
would exit to the shell's prompt rather than to its holder.

A conversation in a multi-session host parks by the same rule, but
never ends the process, which is every conversation the host runs.
The host holds it, so only its wake (`MYCELIUM_WAKE`, which the host
sets for each conversation) and a written log are asked of it. It says
`parked` and writes its marker as below, then asks the host to park
it (`Host.park`), which frees its session and screen while keeping it
held, its window open, and wakes it in place at the wake file, a key
or a window opening on it. Under a host that can't park one
conversation alone, it never parks, and its awake note says
`its host parks it`.

## What Happens

1. The mesh says `parked` in the session's presence. Senders take a
   parked peer as there while its marker stands, so what they send
   it rests on disk until it starts again, as between runs.
2. It writes its marker,
   `park-workflow/parked/<session-id>.json`, naming its log, its
   folder, its addresses, its quest, when it parked and, as `wake`,
   the file its holder wakes it on.
3. pi shuts down as `/quit` would and exits with code 75
   (EX_TEMPFAIL), which tells its holder this is a park, not an end.
   It writes nothing of its own and leaves out pi's "To resume this
   session" hint: the holder says in the window that it parked and
   that a key or a message wakes it, and once was enough.

A message that would give the parked peer a turn (a question or hold
sent to it, an answer to it, a pivot, and for an orchestrator a
finding or news from a session it leads) makes its sender write the
message's id to the marker's `wake` file. A steer telling it to
close or carry its work to another machine wakes it the same way:
any session on the mesh that finds one in a parked peer's inbox,
as it looks about itself each minute, writes the steer's file name
there. The holder looks once a
second, deletes the file and starts the `pi --session` command in the
same window; a key typed in the window wakes it too. The session
deletes its marker as it starts, and says on pi's bus that it woke
(`session:woken:v1`). Once the mesh has caught up, that starts a turn
over the mesh notes no turn has read yet, so a key that woke it is
not left waiting for the person to type something (on 2026-11-07
Joel had to type "." into three woken orchestrators). A first prompt
to come, a run under way or a turn already asked reads them instead.
