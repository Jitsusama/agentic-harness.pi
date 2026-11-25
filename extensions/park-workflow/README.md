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
- no background job running or waiting to say its result, except a
  bash call in a background host on Linux that keeps carried calls
  (`Host.carries`), for a conversation no window views: its park
  carries the call as a host restart does, and the host wakes it once
  the last one ends, passes its time limit or a day, waking it on any
  doubt and asking again until it runs, after five minutes and then
  twice as long each time up to an hour (22
  November, 26 of 78 such conversations, 8.8 GB, were awake only for a
  bash call); `PI_PARK_CARRY=off` on the host keeps such a call
  holding its conversation awake, as before;
- no prompt open for its person, and nothing typed and unsent;
- no peer waiting on a hold it sent;
- no carry of its work to another machine under way, which a park
  or a restart in place would end before its done file is written
  (`its work is being carried to <machine>`; 23 November, a
  conversation idle five minutes parked part-way through one),
  for fifteen minutes at most, so a carry that hangs never holds it
  for good;
- for an orchestrator, no session it leads at work (listening, busy
  or waiting rather than parked or paused), since their findings and
  landings are its to pass on;
- it must not be the session standing at the launcher's top
  (its quest's `stands-at-top`), which takes the person's lines and
  would make each wait for a wake;
- and under niri, its window must be neither focused nor on a
  workspace in sight (`its window is focused`, `its window is on a
  workspace in sight`), since parking closes it, as below.

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
  session after half an hour idle, and a plain pi whose process is
  over a day old after ten minutes, since its wake starts a fresh
  process (one over a day old held 481 MiB on 15 November, against
  267 MiB for one under an hour). A line holding a session's id
  parks that one after two minutes, to prove parking on one session.
  A background host's conversation parks after the lesser of that
  and five minutes idle, since parking gives back what it holds (its
  own process in a child, its share of the host's in the host) and
  nobody watches it wake (75 of them held about 20 GB on 21
  November, 37 idle for five minutes). One a window views waits its
  usual time, since the person may be reading it and would wait out
  its wake at their next key. On macOS every conversation keeps the
  usual limit until a Mac's host survives a park.
- **`PI_PARK=on`,** read at start, as the line `on` does.
- **An ask to ease,** `ease/<session>` beside the switch, which the
  node writes for an idle session of its machine while the machine
  reads over, and takes back once it reads calm. An ask written in
  the last half hour parks a background host's conversation after two
  minutes idle, whatever else the switch says, by the rest of the
  rule as ever; one a window views, a plain pi and a Mac's keep the
  switch's rule, since the person may have it open. Its line (when
  and why) is for people, never read for meaning. The session takes
  the ask back as it parks or wakes from a park; one it never acts on
  (a crash, a stuck sensor) lapses after half an hour, so the node
  writes it again while the machine still reads over, and the node
  sweeps the files of sessions gone. A line `off` in the switch, or
  `PI_PARK=off`, keeps every ask from parking anyone; a switch there
  that can't be read counts as off, and one rewritten in place is
  only as atomic as its writer, so write it by rename. The ask is a
  regular file, never a link or a folder, and one dated more than a
  minute ahead is taken back. The node writes it as the session's
  own user, so the folder is no boundary between accounts.

- **The person's Park,** a steer act `park` from outside the
  window (mesh-workflow's pausing.ts), which the mesh asks of the
  watch on the bus (`PARK_NOW_ASK`): it parks at once, idle time
  aside, once the rest of the rule holds, with its window in sight
  or not, since its person asked; it answers why not where
  anything else holds it or the switch is off. Its marker's idle
  limit is 0, so its wake isn't counted against a rule.

- **A host's drain,** which drops the idle wait for each
  conversation it holds, with the switch empty or its line `off`
  too, since the host itself asked for it. Each still parks only
  once its turn ends and the rest of the rule holds, and
  `PI_PARK=off` still keeps a session out of a drain's park.

Each wake is kept for a day in `wakes/<session>.json` beside the
switch, with how long the session rested parked, so how often a rule
wakes its sessions can be counted.

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

A conversation in a multi-session host parks by the same rule, five
minutes at most in a background host (bar one while a window views
it, and every one on macOS, which keep the usual limit as above
outside a drain), but never ends the host's process, which is every
conversation the host runs. The host holds it, so only its wake
(`MYCELIUM_WAKE`, which the host sets for each conversation) and a
written log are asked of it. It says
`parked` and writes its marker as below, then asks the host to park
it (`Host.park`), which frees its session and screen while keeping it
held, its window open, and wakes it in place at the wake file, a key
or a window opening on it. Under a host that can't park one
conversation alone, it never parks, and its awake note says
`its host parks it`. While its host drains for a restart
(`Host.draining`), it parks as soon as the rest of the rule holds,
idle time aside, so within a look of going idle. So too once its
host's own code is stale and no window views it (`Host.rolling`), as
a child that never restarts rolls onto new code at its next wake.
A drain and a roll each park it even where the park switch or the
default leaves parking off, since each ends a process that must not
outlive its code; only `PI_PARK=off` keeps it awake.

A drain or a roll doesn't wait for a run to end, either, where no
window views it: on 23 November about 40 children ran host code a
day old, each always running, so none ever had an idle look. At the
end of a turn whose tools ran, between its answer and the next ask
of the model, the run steps off: it parks with every other hold
standing, its marker says `goesOn`, and it writes its own wake as it
parks. The draining or stale host holds that wake until it ends
(`SessionHost.holdsWakes`), and the next start carries the run on
where durable left it, on current code. It steps off only where its
host would hold that wake (`Host.wakeHeld`): past a drain's ceiling
the host wakes it at once, and it would park and wake in a loop. A
turn that ends the run steps nothing off; the next look parks it once
pi reads idle. The mesh asks such a park as it asks a restart
(`ParkAsk.goesOn`), since it goes on in the next start, though one
standing at the launcher's top still stays. If its marker can't be
written, it takes its wake back, so a later park isn't woken at once.
Its wake is noted with `goesOn`, so a count of the rule's wakes can
leave it out.

## What Happens

1. The mesh says `parked` in the session's presence. Senders take a
   parked peer as there while its marker stands, so what they send
   it rests on disk until it starts again, as between runs.
2. It writes its marker,
   `park-workflow/parked/<session-id>.json`, naming its log, its
   folder, its addresses, its quest, when it parked, the idle limit
   it parked under (`afterMs`, 0 in a host's drain) and, as `wake`,
   the file its holder wakes it on.
3. When its holder names a file for steers (`MYCELIUM_STEERS`), it
   writes there, whole, the steer inbox of each of its addresses and
   which steers wake it (`{inboxes, wakes}`), as the mesh says. The
   holder watches those folders while it is parked and wakes it as a
   talk, a resume with words, a close, a carry, a move, a fill or
   the person's answer lands, rather than at a running peer's look
   a minute on. With no inboxes to name it clears what an earlier
   park wrote. A
   conversation in a host writes nothing: the host watches its
   inboxes itself.
4. Under niri (`NIRI_SOCKET` set), a plain pi's kitty windows close,
   since its holder outlives them and a sleeping session's window
   only takes the person's attention. It first asks the launcher to
   keep its place asleep (`qs ipc call sessions keepPlaceAsleep
   <session-id>`), so a Return on its Agents row reopens it where it
   was, and closes a window only on the answer `kept`. Each window is
   found by its OS window's class against niri's app id, and checked
   again in `kitten @ ls` before closing, since a restarted kitty
   reuses ids; niri is asked which window is focused just before
   each closes, and one the person has clicked into stays open. When
   niri can't be read, the launcher keeps nothing, or a window can't
   be told apart, it parks with its window open. Its marker then
   says what became of its windows, as `windows`: those closed, by
   kitty id and class, and as `open` why one stayed open. Off niri,
   and in a host, which keeps its conversations' windows, nothing is
   asked of the desktop and the marker says nothing of windows.

   With the screen off, niri puts every workspace on no output, so
   what was in sight is remembered: each read while the screen is on
   writes the workspaces shown to `park-workflow/screen.json`. While
   it is off, those, the window focused last and its workspace, and
   any workspace niri still calls active count as in sight; with
   nothing remembered, no window closes.
5. pi shuts down as `/quit` would and exits with code 75
   (EX_TEMPFAIL), which tells its holder this is a park, not an end.
   Where its holder names a file for it (`MYCELIUM_PARKED`), it first
   writes that file, empty, so a park whose exit then hangs, as on a
   name lookup, and ends by a signal still counts as a park. A
   restart writes it as it commits, before pi ends, and takes it
   back if it is replaced in place. In the window it says nothing
   and leaves out pi's "To resume this session" hint: the holder
   says in the window that it parked and that a key or a message
   wakes it, and once was enough.

A park that fails once it has begun saying so, as a stale context
throwing while pi shuts down, is taken back: its marker, any wake it
wrote and its word to its holder go, and pi's bus says
`session:park-undone:v1`, on which the mesh says it is awake again.
What it couldn't take back is named in the window, since that part
may still read as parked until the session restarts. Windows it
closed stay closed. A host parks its conversation after the asking
call returns, so a host's own later failure is not seen here. A
failed park then holds the clock's next try for half an hour, so one
that fails every time isn't said and taken back each minute; the
person's Park, and a host's drain or roll, still try at once.

Sessions that parked before this closed their windows keep them
open. `scripts/park-windows.ts` lists, by the same checks, which of
them would close now (`--running` adds the held pis awake, and
`--screen <windows.json> <workspaces.json>` replays a saved niri
read), and closes them with `--close <address|session|held|all>`,
stopping if the person's focus moves. Each line carries, as `left`,
what a session's marker kept of why its window stayed open. It runs
by hand, outside the fence.

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
