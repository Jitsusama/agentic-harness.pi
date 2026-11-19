# Session Ending Interceptor

Refuses to ask the person to log out, reboot, restart, shut down or
switch users on a machine while other pi sessions are live there.

## What It Does

Each of those ends every pi session on the machine, busy or idle. On
18 November a session asked for a log-out on equilibrius, and five
sessions ended mid-run. So, under the `no-session-ending-ask-while-live`
guard, which blocks by default:

- **An `ask`, `show_person` or `mesh_wait` call** is refused before it
  runs when its prose asks for one (a prompt, a look's title, why or
  ask, a wait's title, why, when or steps, each step on the wait's
  machine), when an option or choice is one, or when a wait is done at
  the next boot.
- **A reply** that asks for one has its text withheld as pi finalizes
  it, which pi shows in its place and keeps in the session. Its tool
  calls stay. The reason follows once a run as a follow-up, so the run
  goes on and the model says something else; a reply the person
  stopped gets no follow-up. The text was on screen while it streamed.

It is refused while the machine's mycelium node says any session other
than the asker's is on that machine in any state but ended, idle,
unreachable and states it doesn't know included, and whenever the node
can't be read. A session the node names no machine for counts as on
every machine. An ask that names no machine is checked against every
machine the node knows, and the refusal asks for the name. This is the
rule of EWUL44's `se7_guard_no_live_sessions`, which guards its
pairing script's log-out the same way.

Where no mycelium realm is named, as for a consumer without mycelium,
there is no node to ask and nothing is refused.

## What Reads as an Ask

Prose asks only in the form of an ask: an imperative ("Reboot
optimus", also after "if the mic is dead," or as "try logging out"), a
request followed by the act as a verb ("could you reboot", "you'll need
to log out", "may I") or a need ("needs a reboot"). A reboot that
happened, one a change waits for, or one a request only asks about
("could you check whether the reboot fixed it") asks nothing. Options
and choices are the ask itself, so the act counts there whenever it is
a verb rather than a time ("after the reboot").

A restart, shutdown or power-off counts only of a machine or with no
object ("restart now"), so restarting the shell or pi is left alone; a
reboot of another device, as a router, is too, and so is a log-out out
of something else, as gh. A session-ending command (`sudo reboot`,
`systemctl poweroff`, `loginctl terminate-user`, `niri msg action
quit`) asks on a line of a shell's fenced code, or in inline code a
sentence asks to run, on the machine an `ssh` in front of it names when
the node lists it. The reading is in
`lib/internal/session-ending/asks.ts`, and the verdict in `judge.ts`
beside it.

## Where an Ask Goes Instead

To the session's orchestrator, which schedules a disruption with the
person once the sessions on that machine are ended or carried.
