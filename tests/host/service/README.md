# Service Tests

Protocol validation, byte framing and session-scoped engine dispatch.
socket.test.ts checks real private sockets, strict replies and bounded
transport with H1 ownership and V Terminals, including reconnect. These
tests use an injected engine with two sessions in one process. They do not
start a production host, copy credential files or use Joel's screen.
