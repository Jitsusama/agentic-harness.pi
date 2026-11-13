# Service Tests

Protocol validation, byte framing and session-scoped engine dispatch.
socket.test.ts checks real private sockets, strict replies and bounded
transport with H1 ownership and V Terminals, including reconnect. These
tests use an injected engine with two sessions in one process.
backend.test.ts drives the backend over the real SessionHost, roster
and socket with a fake engine: hold before registration, undo of an
unregistered start, holds kept through stop and failed closes, resume
at start with the launch environment held at open, refusal of one
naming a credential, and two sessions each in its own environment. Its rollout
gate tests check a second open, an adopt and a resume past the first
are refused before anything is held, and that two opens at once can't
both go first.
rollout.test.ts judges a `loaded/` folder with fake pid and dating
facts, and dates roots against a throwaway git repository in a private
folder: self, dead and malformed files, roots dated once, cleared roots
kept and stale ones asked again, and a host run from a tree keeping to
one conversation.
serve.test.ts starts and stops whole hosts in a private folder: a second
host of one key and a refused engine never listen, and holds survive
stop and resume at the next start. The stale-rejection net is mocked,
so the test worker keeps its own handling; the test checks a host sets
it before its engine loads.
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
the install changes the host's own code or systemd has a new unit, and
only with every conversation settled, no background work held and
every screen at rest; never outside a unit or as a process that isn't
the unit's main one; and a restart systemd refused leaves no viewer
told.
what-starts.test.ts checks the import walk and fingerprint over a
private tree, reading the unit from a cgroup file, and the unit's
files read only once systemd has reloaded them.
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
unreadable roster, in a private temporary folder. They do not
start a production host, copy credential files or use Joel's screen.
