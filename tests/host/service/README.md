# Service Tests

Protocol validation, byte framing and session-scoped engine dispatch.
socket.test.ts checks real private sockets, strict replies and bounded
transport with H1 ownership and V Terminals, including reconnect. These
tests use an injected engine with two sessions in one process.
backend.test.ts drives the backend over the real SessionHost, roster
and socket with a fake engine: hold before registration, undo of an
unregistered start, holds kept through stop and failed closes, resume
at start, and two sessions each in its own environment.
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
holds kept on a stop signal, and no socket without a realm.
gateway-key.test.ts checks the launcher's key order and when a personal
key is resolved again, with a fake resolver and a stamp file in a
private folder; the dev tool itself is never run.
roster.test.ts checks durable holds across stop and a host that died
without closing, lock refusal and takeover races, and refusal to start
over an unreadable roster, in a private temporary folder. They do not
start a production host, copy credential files or use Joel's screen.
