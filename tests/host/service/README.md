# Service Tests

Many entries because each file mirrors one module of host/service, which
keeps a module a reason to change, so a test sits beside the one it
checks rather than in a folder grouping several.

Protocol validation, byte framing and session-scoped engine dispatch.
socket.test.ts checks real private sockets, strict replies and bounded
transport with H1 ownership and V Terminals, including reconnect. These
tests use an injected engine with two sessions in one process.
backend.test.ts drives the backend over the real SessionHost, roster
and socket with a fake engine: hold before registration, undo of an
unregistered start, holds kept through stop and failed closes, resume
at start with the launch environment held at open, refusal of one
naming a credential, and two sessions each in its own environment. Its gate
tests check a second open, an adopt and a resume past the first
are refused before anything is held, and that two opens at once can't
both go first. Its start-order tests hold one resume back and check one
asked for goes next, and that a window, wake and close asked meanwhile
each wait for the start's own resume rather than resuming again.
backend-children.test.ts drives that backend with fake children: what
moves resumes and wakes in a child, and a start's resume is hurried for
whoever waits on it. backend-child-opens.test.ts has its opens and
adopts in a child, and the refusals it passes on. Both share
support/backend-children.ts.
serve.test.ts starts and stops whole hosts in a private folder: a second
host of one key and a refused engine never listen, holds survive
stop and resume at the next start, and a starting host answers a list
before it has resumed what it held. The stale-rejection net is mocked,
so the test worker keeps its own handling; the test checks a host sets
it before its engine loads. Its cases, and run.test.ts's realm host,
take their runtime folder from support/short-runtime.ts: under the
run's temp folder when a child's socket fits there, else under the
run's short folder in /tmp, since a session's temp folder is too long
for one. Where /tmp may not be written there is no short folder, so it
stays under the temp folder and only the cases needing children fail.
short-runtime.test.ts checks all three, two at the limit's edge.
children.test.ts checks a host passing what names a conversation a
child runs to the child's socket over real sockets with fake backends:
an attach and the window's keys and frames both ways, a frame split
across the hand-over, a close under the child's own identity with the
connection the host's again after it, a stale host refused before the
child hears of it, a child answering as another process, lists naming
each conversation once, a child that is gone or ends without
answering, a window told when its child ends under it, a restart's
frame sent at a frame's edge and after an attach's answer, and a child
left unread while its window reads nothing.
child-supervisor.test.ts runs the supervisor against children in this
process, started by fake units a little after their unit starts: a
resume's slot naming its roster entry, one child for two resumes, a
child ending before it listens or never listening given up, a host's
stop at each step of a start, a slow watch included, a unit systemd
won't start, a child running another conversation refused and one
naming its own in another case taken, state, a new id and an ending
each kept in the routes, a child whose new id is held or run elsewhere
or can't be held stopped, with a start of that id waiting on it, what
a newer child adds passed over, an unreadable line and a silent exit
as failed, and a folder too long refused.
child-claims.test.ts runs them for whose conversation a child holds:
the roster's hold spelled in capitals replaced by what it became and
let go on a close, a became followed in another case, and a resume
kept in its own slot after another child claimed its conversation.
child-leaving.test.ts runs them as each leaves: a unit stopped three
times before its slot is kept in use, naming the command that ends it,
a systemd that once won't say asked again, and a slot freed once its
unit has gone.
child-opens.test.ts runs the same children for opens and adopts: an
open asked of the child without the host's identity, a refusal
stopping its child, an open or adopt of a held id or one its watch
contradicts refused, its slot named before the roster holds it, an
open answered late named rather than stopped, a begin's one deadline
and a stop ending its ask, a resume waiting on the open's slot, and
the gate's turns. child-adopts.test.ts has a host starting again taking
up the children left running, once for two adopts, under the ids they
now run, a busy one tried again with each try said, one systemd won't
say has gone watched, a second one running a conversation stopped, and
a start waiting on one it couldn't take up under another id.
support/supervised-children.ts is their fake units, roster and
children, each child's traits set by the test that starts it.
child-policy.test.ts checks the policy file read as it changes: one
named, all, a missing file and an unreadable one each moving nothing.
child-hosting.test.ts puts the routes, supervisor and policy together
over fake children: the policy read as it stands, a child's
conversation listed until it ends, one ended parked or failed rested so
its wake is watched, one closed not, and a close leaving children
running. support/fake-children.ts holds its children in this process
and the fake units that start them.
child-units.test.ts checks a slot's paths and unit, and that a name
reaching another path or unit is refused.
own-threads.test.ts runs the host and two children as node processes
of their own: while one conversation holds its child's thread for 3 s,
the host answers a list, and the other conversation takes a turn and
draws a window's first frame, each within 1 s. It is in the process
lane.
killed-host.test.ts runs a host in a node process of its own, kills it
with SIGKILL after two opens, and starts the next host of the key here:
it takes over the left lock and socket and resumes both holds. It is in
the process lane, since it spawns node from node.
run.test.ts runs a host as its process would, with a stand-in for the
process's signals and readiness: ready only once listening, parked with
holds kept on a stop signal, the viewer bridge handed to serve, and no
socket without a realm.
program.test.ts checks what the host program refuses before it holds,
pins or listens anything, the environment it gives conversations, the
terminal it names and the theme it starts. Its run against the real patched pi is a drill, not a
test here, since that pi is built outside this package;
tests/scripts/pi-host.test.ts checks the exit status a unit reads.
restart.test.ts checks when a host restarts itself, with timers fired
by hand and a fake systemctl over an install in a private folder: once
the install changes the host's own code, systemd has a new unit or the
heap passes half its limit, and only with every conversation settled,
no background work held and every screen at rest; never outside a unit or as a process that isn't
the unit's main one; and a restart systemd refused leaves no viewer
told. A Mac's host, a launchd job, exits to restart rather than asking
systemctl, arming no wait for systemd even when its exit ends nothing
itself, and follows nothing with no way to exit or as no job, saying
why; a Linux unit given a way to exit still asks systemctl.
program.test.ts checks the exit status a stop gives, that a restart
by exit stays down after a stop signal in each order they can come,
and that launchd's Label stays out of conversations; run.test.ts that
a stop signal is remembered, even one come during a stop the host
asked of itself, and that a second is still heard.
what-starts.test.ts checks the import walk and fingerprint over a
private tree, reading the unit from a cgroup file, the unit's
files read only once systemd has reloaded them, and a launchd job told
from a host started in a terminal or left behind by its parent, and
from Labels that only nearly name a pi host.
pi-resolution.test.ts checks the host program's resolve hook sends only
pi imports made from outside the host's pi to that pi.
gateway-key.test.ts checks the launcher's key order and when a personal
key is resolved again, with a fake resolver and a stamp file in a
private folder; the dev tool itself is never run.
settings.test.ts reads the host's config section from a private
folder: the quiet collection on with no file or no say, off when it
says false, and a bad value or file said with the defaults kept.
viewer.test.ts checks the bridge notices each key and resize before
the screen takes it, and passes edits and detaches on unnoticed.
roster.test.ts checks durable holds across stop and a host that died
without closing, lock refusal and takeover races, launch environments
written only when they hold something, and refusal to start over an
unreadable roster, in a private temporary folder.
repeats.test.ts checks a spawn asked again inside its window gets the
first answer rather than a second conversation, whatever stage token it
carries, and only while what it opened still stands. They do not
start a production host, copy credential files or use Joel's screen.

- `support/`: helpers these tests share, such as the fake units,
  roster and children the supervisor's and hosting's tests run.
