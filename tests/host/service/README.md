# Service Tests

Protocol validation, byte framing and session-scoped engine dispatch.
socket.test.ts checks real private sockets, strict replies and bounded
transport with H1 ownership and V Terminals, including reconnect. These
tests use an injected engine with two sessions in one process.
roster.test.ts checks durable holds across stop and a host that died
without closing, lock refusal and takeover races, and refusal to start
over an unreadable roster, in a private temporary folder. They do not
start a production host, copy credential files or use Joel's screen.
