# Host Service

The service owns versioned JSON-lines control framing and dispatch beside
H1's engine and V's Terminal. It does not implement pi's session loop,
input pipeline or screen. No production listener or unit is installed yet.

- protocol.ts: strict v1 control requests and attached-viewer input.
- framing.ts: bounded UTF-8 JSON lines; only LF separates records.
- dispatch.ts: validates before engine calls and binds targeted calls
  through core/session's withSession.

The public sessionId is always pi's stable UUID, never durable's internal
conversation id. Control operations are open, adopt, list, release, close,
abort and attach. Attached viewer events are input and resize. The listener
will own the mode-0600 socket, backpressure and detach on EOF.

Unknown fields and operations fail closed. Credentials and arbitrary
environment maps are not accepted through this protocol. Engine failures
return a correlated generic error rather than leaking incoming data or
credential-bearing exception text. The production engine must record its
own actionable journal errors.

This first boundary deliberately has no engine implementation, roster,
listener, release lock or recovery mechanism. Those follow H1 integration.
