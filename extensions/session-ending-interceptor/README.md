# Session Ending Interceptor

Refuses to ask the person to log out, reboot, restart, shut down or
switch users on a machine while other pi sessions are live there.

## What It Does

Each of those ends every pi session on the machine, busy or idle. On
18 November a session asked for a log-out on equilibrius, and five
sessions ended mid-run. So, under the `no-session-ending-ask-while-live`
guard, which blocks by default:

- **An `ask`, `show_person` or `mesh_wait` call** is refused before it
  runs when its prose asks for one (a prompt, a look's why or ask, a
  wait's why or when), when an option, a choice, a look's title or a
  wait's title or step names one, when a wait's check is a
  session-ending command, or when a wait is done at the next boot. A
  wait's title and steps are read on the wait's machine; settling a
  wait (`done`) asks nothing.
- **A reply** that asks for one has its text withheld as pi finalizes
  it, which pi shows in its place and keeps in the session. Its tool
  calls stay. The reason follows once a run as a follow-up, so the run
  goes on and the model says something else; the placeholder says a
  reason follows only when one does, and a reply the person stopped or
  that ended in an error gets none. The text was on screen while it
  streamed.

Asked again unchanged, a refused call or reply goes through as a
recorded override. It is known again by the act and the machines it
asks for, not by the refusal's wording, since sessions move between
busy and idle in seconds.

It is refused while the machine's mycelium node says any session other
than the asker's is on that machine in any state but ended, idle,
unreachable and states it doesn't know included, and whenever the node
can't be read. A session the node names no machine for counts as on
every machine. An ask that names no machine is checked against every
machine the node knows (the sessions' machines and the node's
`Machines` list), and the refusal asks for the name. This is the
rule of EWUL44's `se7_guard_no_live_sessions`, which guards its
pairing script's log-out the same way.

Where no mycelium realm is named, as for a consumer without mycelium,
there is no node to ask and nothing is refused. A realm named with no
node to answer, its runtime folder missing included, counts as a node
that can't be read, and refuses.

## What Reads as an Ask

Prose asks only in the form of an ask: an imperative ("Reboot
optimus", also after "if the mic is dead," or as "try logging out"), a
request followed by the act as a verb ("could you reboot", "you'll need
to log out", "may I") or a need ("needs a reboot"). A reboot that
happened, one a change waits for, or one a request only asks about
("could you check whether the reboot fixed it") asks nothing. Options
and choices are the ask itself, so the act counts there whenever it is
named rather than a time ("after the reboot").

What a reply only talks about asks nothing: an act in a heading or
label ("Restart: the host hasn't restarted"), the subject of a verb
("reboot passed"), a noun ("one more restart"), a name (`restart.ts`,
`fix-switch-signed-out-drop`), a list of acts, or a quoted example,
but for a button to click (`click "Restart"`). These were taken from
the replies sessions here wrote over two days.

A restart, shutdown or power-off counts only of a machine or with no
object ("restart now"), so restarting the shell or pi is left alone; a
reboot of another device, as a router, is too, and so is a log-out out
of something else, as gh. A sentence that names only this machine or
your laptop names none. A session-ending command (`sudo reboot`,
`systemctl poweroff`, `loginctl terminate-user`, `niri msg action
quit`, and macOS's `fdesetup authrestart`, `launchctl reboot` and
`osascript` restarts) asks on a line of a shell's fenced code, after a
prompt in a console's, or in inline code a sentence asks to run, on
the machine an `ssh` in front of it names when the node lists it. The reading is in
`lib/internal/session-ending/asks.ts`, and the verdict in `judge.ts`
beside it.

## Where an Ask Goes Instead

To the session's orchestrator, which schedules a disruption with the
person once the sessions on that machine are ended or carried.
