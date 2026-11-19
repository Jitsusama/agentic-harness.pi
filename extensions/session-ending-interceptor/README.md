# Session Ending Interceptor

Refuses to ask the person to log out, reboot, restart, shut down or
switch users on a machine while other pi sessions are live there.

## What It Does

Each of those ends every pi session on the machine, busy or idle. On
18 November a session asked for a log-out on equilibrius, and five
sessions ended mid-run. So, under the `no-session-ending-ask-while-live`
guard, which blocks by default:

- **An `ask` or `show_person` call** is refused before it runs when a
  prompt or a look's why asks for one, or an option, choice, title or
  look's ask is one.
- **A reply** that asks for one has its text withheld as pi finalizes
  it, which pi shows in its place and keeps in the session. Its tool
  calls stay. The reason follows as a message, so the run goes on and
  the model says something else. The text was on screen while it
  streamed.

It is refused while the machine's mycelium node says any session other
than the asker's is on that machine in any state but ended, idle and
unreachable included, and whenever the node can't be read. An ask that
names no machine is checked against every machine the node knows, and
the refusal asks for the name. This is the rule of EWUL44's
`se7_guard_no_live_sessions`, which guards its pairing script's
log-out the same way.

## What Reads as an Ask

Prose asks only in the form of an ask: an imperative ("Reboot
optimus"), a request ("could you", "you'll need to", "may I") or a
need ("needs a reboot"). A reboot that happened, or one a change waits
for, asks nothing. A restart, shutdown or power-off counts only of a
machine, so restarting the shell or pi is left alone, and a log-out out
of something else, as gh, is too. A line of fenced code opening with a
session-ending command (`sudo reboot`, `systemctl poweroff`, `loginctl
terminate-user`, `niri msg action quit`) asks, on the machine an `ssh`
in front of it names. The reading is in
`lib/internal/session-ending/asks.ts`, and the verdict in `judge.ts`
beside it.

## Where an Ask Goes Instead

To the session's orchestrator, which schedules a disruption with the
person once the sessions on that machine are ended or carried.
