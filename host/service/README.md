# Host Service

The service owns versioned JSON-lines control framing and dispatch beside
H1's engine and V's Terminal. It does not implement pi's session loop,
input pipeline or screen. No unit or running host is installed yet.

- address.ts: the host's realm (MYCELIUM_REALM, else PI_HOME_REALM),
  its realm-kind key and its socket in XDG_RUNTIME_DIR.
- backend.ts: the control backend over the engine's live ownership and
  the roster. Open and adopt hold durably before the engine registers;
  a start that never registered is undone, one that registered and
  failed stays held. Close and release drop the hold only after the
  engine's close commits. resumeHeld resumes each hold at start, keeping
  one that won't resume held and listed parked for a person to close.
  The engine it drives (prepare, start, discard, resume, abort) is H1's.
  conversationEvents is what the engine, watched once before anything
  resumes, tells the service of a change made inside pi: a conversation
  that ended itself is dropped, and one that became another (pi's new,
  fork or resume) is held in its place in one write, keeping attended,
  quest and launch. Host stop never counts as an end.
- rollout.ts: the rollout gate. A host opens, adopts or resumes a
  second conversation only once every live pi (each `loaded/<pid>`
  in the install whose pid runs) loaded a harness holding 5b5b7260,
  whose mesh census judges hosted presences each on its own; an older
  one takes all but the newest as ended. A root that can't be read or
  dated counts as stale, and the refusal names each stale pid and
  root. One conversation per host is never gated. A host run from a
  tree keeps to one. `node scripts/host-rollout.ts` prints the same
  verdict for a person.
- serve.ts: one realm-kind host's life. It takes the roster's lock,
  installs SessionHost, loads the engine, resumes what is held and only
  then listens, so a second host, an unreadable roster or a pi the
  engine refuses never reaches a socket. Stop closes the socket, parks
  every conversation as signalled and releases the lock, keeping holds.
  It watches the engine before resuming, so no end or replacement is
  missed.
  Start first sets the package's stale-rejection net, logging under
  the host's state folder, so one conversation's reload leftovers never
  end the host and its other conversations.
- run.ts: a host as systemd runs it: kind from the command line, realm
  from the unit's environment, ready (systemd-notify, so the unit needs
  NotifyAccess=all) only once it listens, and parked on SIGTERM or
  SIGINT. The engine is passed in by the program that starts it.
- program.ts: that program, which `scripts/pi-host.ts` runs. It loads
  the host's pi from PI_PACKAGE_DIR, refused unless every host patch is
  there, starts pi's theme from the person's settings, and gives each
  conversation pi's InteractiveMode as its screen, H1's engine and the
  renewing key. It names the viewers' kitty terminal where the unit
  names none, before the theme reads it. Conversations start from the
  host's environment less systemd's hand-over and PI_PACKAGE_DIR; the
  engine pins the host's pi for their subagents. A kind, realm
  or pi install it refuses exits 78, before anything is held or
  listens, so a unit naming that status stops restarting it.
- pi-resolution.ts: the resolve hook `scripts/pi-host.ts` registers
  before the host's code loads, binding every `@earendil-works/` import
  made from outside the host's pi to that pi. The harness's install
  carries no pi of its own, so without it the viewer's terminal would
  find no pi-tui, or in a tree the dev copy rather than the host's.
- roster.ts: the durable realm-kind roster behind one lock per key.
  Holds are written before registration and dropped only after a close
  or release commits, or once a conversation ended itself; replace swaps
  one hold for another in one write. Stop and kill -9 keep them. A live
  or unjudgeable lock holder, a malformed lock or an unreadable roster
  refuses start. A dead holder's lock is moved aside and checked, never
  just unlinked.
  Each hold keeps the launch environment the engine derived at open,
  such as an experiment arm, for resume to replay; one naming a
  credential is refused, since keys come from the host per request.
- gateway-key.ts: the work host's one gateway key. An inherited key
  stays fixed, as the launcher treats it; otherwise the personal key is
  resolved through the dev tool and resolved again when the dev cache's
  expiry stamp moves, nears, or the gateway refuses the key.
- viewer.ts: adapts V's persistent Terminal without reproducing its parser.
- protocol.ts: strict v1 control requests, replies and viewer input.
- framing.ts: bounded UTF-8 JSON lines; only LF separates records.
- dispatch.ts: validates before engine calls and binds targeted calls
  through core/session's withSession; forwards failures to the host journal.
- server.ts: private Unix listener, bounded writes, scoped viewer input
  and disconnect cleanup. It takes over only this user's socket that
  nothing answers, as a killed host leaves, once the caller holds the
  roster lock; a live socket, a file or another user's socket is refused.
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
SessionHost, not a running AgentSession. backend.ts is tested with a
fake engine; H1's real one, and the program systemd starts, follow. V supplies the ViewerBridge;
H2 does not reproduce InteractiveMode.
