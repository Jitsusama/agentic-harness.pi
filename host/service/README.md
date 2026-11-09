# Host Service

The service owns versioned JSON-lines control framing and dispatch beside
H1's engine and V's Terminal. It does not implement pi's session loop,
input pipeline or screen. No unit or running host is installed yet.

- address.ts: the host's realm (MYCELIUM_REALM, else PI_HOME_REALM),
  its realm-kind key and its socket in XDG_RUNTIME_DIR.
- roster.ts: the durable realm-kind roster behind one lock per key.
  Holds are written before registration and dropped only after a close
  or release commits; stop and kill -9 keep them. A live or unjudgeable
  lock holder, a malformed lock or an unreadable roster refuses start.
  A dead holder's lock is moved aside and checked, never just unlinked.
- viewer.ts: adapts V's persistent Terminal without reproducing its parser.
- protocol.ts: strict v1 control requests, replies and viewer input.
- framing.ts: bounded UTF-8 JSON lines; only LF separates records.
- dispatch.ts: validates before engine calls and binds targeted calls
  through core/session's withSession; forwards failures to the host journal.
- server.ts: private Unix listener, bounded writes, scoped viewer input
  and disconnect cleanup. It never unlinks an existing socket or file.
- client.ts: one-shot control requests with strict reply correlation and
  a bounded timeout. It never retries a possibly committed operation.

The public sessionId is always pi's stable UUID, never durable's internal
conversation id. Control operations are open, adopt, list, release, close,
abort and attach. Attached viewer events are input and resize. The listener
owns a mode-0600 socket inside a user-owned mode-0700 directory. Viewer
output is bounded at 4 MiB pending writes; EOF detaches only the viewer.
Attach replies precede initial screen output on the same connection.
Close, release and abort over a socket require expectedHost discovery
identity. Direct internal dispatch still permits an unguarded request.

Unknown fields and operations fail closed. Credentials and arbitrary
environment maps are not accepted through this protocol. Engine failures
return a correlated generic error rather than leaking incoming data or
credential-bearing exception text. The production engine must record its
own actionable journal errors.

The listener and client are tested against an injected engine and H1's
SessionHost, not a running AgentSession. The roster is not yet wired
to the engine, so nothing resumes on start yet. V supplies the ViewerBridge;
H2 does not reproduce InteractiveMode.
