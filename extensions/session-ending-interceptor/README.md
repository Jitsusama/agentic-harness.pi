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
  wait's why or when), when a question's tab label, an option, a
  choice, a look's title or a wait's title or step names one, when a
  wait's check is a session-ending command, or when a wait is done at
  the next boot. An ask in a wait's title or steps that names no
  machine is read as on the wait's machine, in any case, when the
  node knows it; one it doesn't know names none, so every machine is
  checked. Settling a wait (`done`)
  or taking a look back (`withdraw`) asks nothing.
- **A reply** that asks for one has its text withheld as pi finalizes
  it, which pi shows in its place and keeps in the session. Its tool
  calls stay. The reason follows once a run as a follow-up, so the run
  goes on and the model says something else; the placeholder says a
  reason follows only when one does, and a reply the person stopped or
  that ended in an error gets none. The text was on screen while it
  streamed. Each reply withheld is said on the bus
  (`reply:withheld:v1`), so the mesh's talk to the launcher, which pi
  may have handed the reply first, is replied by the placeholder too.

Asked again unchanged, a refused call or reply goes through as a
recorded override. It is known again by every act and machine it asks
for, not by the refusal's wording, since sessions move between busy
and idle in seconds; an ask added beside a refused one is refused
afresh. A reply's override holds only for an ask the model was told
of, and only in the run it was told in, so a reply withheld without a
word (a second in a run, or one the person stopped) can't go through
as an ask the model chose. A reply the person stopped is withheld
without a word whatever the mode but off, so it never spends an
override.

It is refused while any of the machine's mycelium nodes, one a realm
(work and personal here), says a session other than the asker's is on
that machine in any state but ended, idle, unreachable and states it
doesn't know included, and whenever any of them can't be read. A
reboot ends every realm's sessions, so each node is asked. The
session's own realm's node must answer; another realm's socket that
refuses a connection, as one a node that ended leaves behind, holds
no sessions, while one that connects and says nothing still refuses. The
addresses, states and machine names a node gives are said in a refusal
only when they keep to their shapes. A session the node names no machine for counts as on
every machine. An ask that names no machine is checked against every
machine the node knows (the sessions' machines and the node's
`Machines` list, with this machine standing in for the sessions'
when they can't be read), and the refusal asks for the name. This is the
rule of EWUL44's `se7_guard_no_live_sessions`, which guards its
pairing script's log-out the same way.

Where no mycelium realm is named, as for a consumer without mycelium,
there is no node to ask and nothing is refused. A realm named with no
node to answer, its runtime folder missing included, counts as a node
that can't be read, and refuses.

## What Reads as an Ask

Prose asks only in the form of an ask: an imperative ("Reboot
optimus", also after "if the mic is dead," or a dash, or as "try
logging out"), a request or hedge followed by the act as a verb
("could you reboot", "you might need to log out", "can we restart",
"feel free to reboot", "may I"), a need ("needs a reboot") or the act
first, then a step ("once you log out, pair the card"). What would
follow one ("if you reboot, five sessions end", "when you reboot,
niri restores the windows", "until we can reboot") asks nothing,
and nor does a reboot that happened, one a change waits for, or one
a request only asks about ("could you check whether the reboot
fixed it"). Options
and choices are the ask itself, so the act counts there whenever it is
named rather than a time ("after the reboot"), unless it turns the
act down ("Skip the reboot", "No restart tonight"). The decline has
to govern the act: "Cancel the backup and reboot", "No, reboot now",
"Don't forget to log out" and "Don't skip the reboot" still ask, and
"Don't reboot, just log out" asks for the log-out.

What a reply only talks about asks nothing: a markdown heading that
names no machine ("### 2. Reboot optimus" asks), a ticked task box, an
act in a label of a word or two before a colon ("Restart: the host
hasn't restarted", though "Reboot optimus: the kernel's in", "Reboot
now: the kernel's in" and "Log out of macOS: the card pairs at login"
ask) or a bold one of any
length ("**Reboot at 22:29:**"), the subject of a verb
("reboot passed"), a thing the act only qualifies ("reboot handling
works", "the restart limit", "Keep the reboot check"), the rest of a
sentence wrapped onto a new line, a noun ("one more restart"), a
name (`restart.ts`, `fix-switch-signed-out-drop`, a command in inline
code the sentence doesn't ask to run), a list of acts, a word against
it a word or two before ("doesn't seem to need a reboot"), or a quoted
example. A button or menu item to pick is an ask when it is the act
alone (`click "Restart"`, "choose Apple menu > Log Out", "click the
Restart button"), not "Restart Kernel" or "restart on the language
server", and so is an act after another step ("save your work and log
out"). A command counts in inline code or a quote only right after a
word asking to run it ("run `sudo reboot`"). These were
taken from the replies sessions here wrote over two days.

A restart, shutdown or power-off counts only of a machine or with no
object ("restart now"), so restarting the shell or pi is left alone; a
reboot of another device, as a router, is too, and so is a log-out out
of something else, as gh. A sentence that names only this machine,
your laptop or the MacBook names none, so every machine is checked. A session-ending command (`sudo reboot`,
`systemctl poweroff` with any options or by `.target`, `loginctl
terminate-user` or `terminate-seat`, logind over `busctl`, stopping
the display manager or the compositor, `pkill -u` of a user, `niri msg
action quit`, the desktops' own log-outs, and macOS's `fdesetup
authrestart`, `launchctl reboot` and `osascript` restarts, run by path
or through `sudo`, `pkexec`, `su -c`, `timeout`, `systemd-run`,
`xargs`, a subshell or an `if`'s branch; not `shutdown -c`, which
cancels one) asks on a line of a shell's fenced code but a comment,
after a prompt in a console's (in one with no prompts, a line that
ends a sentence is prose), or in inline code a sentence asks to run, on
the machine an `ssh` in front of it names when the node lists it. The reading is in
`lib/internal/session-ending/asks.ts`, and the verdict in `judge.ts`
beside it.

## Where an Ask Goes Instead

To the session's orchestrator, which schedules a disruption with the
person once the sessions on that machine are ended or carried.
