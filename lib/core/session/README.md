# Session Seam

One place to ask which conversation owns state, environment and work.
On plain pi, no host is installed: slots keep their existing global
symbols, environment calls read and write process.env, and owners name
the process as before. No extension is migrated by adding this module.

A host and a downstream package import the public barrel at
agentic-harness.pi/core/session. The contract has no dependency on
pi-durable or on pi's concrete context types.

## Identity and State

- sessionKeyOf(ctx) returns ctx.sessionManager.getSessionId(). Keep this
  id for life, reopening the same pi mirror file on host restart.
- sessionCwd(ctx) returns ctx.cwd, never the host's process.cwd().
- withSession(id, fn) runs a hook, tool or callback within the shared
  AsyncLocalStorage. ambientSession() reads that id, or undefined
  outside a wrapped call. The store is shared across separately loaded
  extension and package copies.
- sessionSlot(name, ctxOrIdOrUndefined, create) returns the old
  Symbol.for(name) value on pi. In a host it keys by session and name.
  Explicit ctx or id outranks ambient context. A hosted call without
  either throws NoSessionInHost.
- sessionCell(name, ctxOrIdOrUndefined) is a slot that can be empty,
  with get(), set(value) and clear(). On pi the value itself sits under
  Symbol.for(name), and clear() deletes it, exactly as code that
  predates the cell keeps it, so a reload between versions still finds
  what the last one left. In a host it keys by session and name, like
  sessionSlot, and is resolved once, when the cell is made.
- releaseSession(id) frees that hosted session's slots and cells on close.
  Never call it on reload. It does nothing on plain pi. The host owns
  disposal of timers, listeners, env and hints; deleting a slot does not
  dispose resources stored in it.

Prefer explicit ctx whenever available. Timers and promises created in
a wrapped call inherit its context. A shared watcher created for A does
not magically become B's watcher: bind each dispatch with withSession
for its target. Shared process infrastructure must not read ambient
session state.

## Environment and Startup

sessionEnv(ctxOrId?) returns an object with get(name), set(name, value),
delete(name) and snapshot(). On pi these act on process.env; snapshots
are independent copies. In a host, Host.env supplies the conversation's
mutable environment and copy semantics. These are not a temporary
process.env overlay.

The host merges the snapshot into command execution and child process
environments, setting PI_SESSION_ID to the stable pi session id. This
module does not change pi-ai's environment-key authentication. Different
model-provider keys still require the separate host/provider solution.

launchHints(ctxOrId?) consumes Host.hints in a host. Plain pi consumes
QUEST_WORKFLOW_AUTOLOAD_ID, QUEST_WORKFLOW_ORCHESTRATE (true only at 1)
and QUEST_WORKFLOW_FIRST_WORDS. The last is a file token, returned as
firstWordsToken, not prompt text. The existing quest first-words reader
must resolve that token. Hosted firstWords are literal text.

## Host Contract

Call installHost(host) before loading any extensions. A second install
throws. It returns cleanup that removes only that host; use cleanup
only once its conversations have stopped. hosted() reads the same
agentic-harness.host.v1 symbol in every library copy.

Host supplies:

- kind: pi-durable, key: a stable host identifier, and owner: the host's
  pid, startedAt, optional bootId and optional startTicks.
- holds(id): busy, idle, parked or undefined when closed.
- env(id): that conversation's SessionEnvironment.
- hints(id): LaunchHints, consumed once, not again on reload.
- close(id, why): stop accepting input and emit session_shutdown for
  just that conversation.
- stamp(id, how): emit SESSION_STAMP_EVENT on that conversation\'s
  pi.events bus inside withSession. The payload is SessionStamp:
  session (the pi id) and how (signalled or closed). The quest workflow
  records the ending and releases its lease. Emit before runner shutdown;
  reload and viewer detach emit neither ending. Remove subscriptions on
  runner shutdown so reload does not keep an old quest state.
- park(id), optionally: park one idle conversation, as park-workflow
  asks once its rule holds. The host stops it as at a host stop,
  keeping it held, and wakes it in place when the file its
  MYCELIUM_WAKE names is written, a viewer types or one attaches. The
  park happens after the asking call returns.

Wrap every runner entry, tool execution, provider hook, input handler
and host callback with withSession(id, fn). A missing wrap is visible
as NoSessionInHost when session state is requested. Do not use
enterWith: sibling dispatches must restore the caller's context.

## Ownership and Other Processes

sessionOwner(ctxOrId?) returns the current ticked pi owner, or the
host owner plus session and host fields. SessionOwner is exported
for host authors. Core ownerStanding and tickedStanding first check
the process identity, then check whether that host still holds the
session. Legacy owners have no extra check. processKey distinguishes
co-hosted session owners while preserving its legacy process key.

Other processes read HostRegistry: key, owner and sessions, each with
id, state and since (an ISO timestamp). hostRegistryPath(owner) names
the list under the existing package state folder:

~~~text
$XDG_STATE_HOME/pi/agentic-harness.pi/hosts/<pid>-<startTicks>.json
~~~

Without startTicks the filename uses startedAt instead, supporting
macOS. XDG_STATE_HOME falls back to ~/.local/state. Rewrite the whole
list atomically on every open, close and state change. Serialize publication
in state-change order so an older snapshot cannot overwrite a newer open.
Publish it
before a session publishes any lease or presence. An absent session
in a valid list is gone; missing, malformed or mismatched lists are
unknown, never proof that reclaiming work is safe. askedOnce and
askedOnceWithTicks share each host list snapshot within that census or sweep;
start a fresh fact operation for the next sweep rather than caching verdicts.

endSession(owner, why?) invokes Host.close only for an owner matching
the installed host's full process identity. Plain owners get today's
SIGTERM only after its recorded process identity is confirmed running;
gone, unknown or malformed owners are refused. Closing a hosted owner in another process refuses and names
the host control socket: the transport belongs to the host/mesh piece,
not this module. It never sends SIGTERM to a shared host.

## Held for Resume

roster.ts is imported directly, not through the barrel. HostRegistry
files name a host process and vanish with it; each realm-kind host also
keeps a roster under the package state folder that outlives restarts:

~~~text
$XDG_STATE_HOME/pi/agentic-harness.pi/host-rosters/<realm>-<kind>.json
~~~

The host writes a hold before the engine registers a conversation and
removes it only after a deliberate close or release commits. A host
stopping, crashing or being killed leaves its holds in place.

heldSessionStatus(id, {dir?, hostKey?}) answers held, unheld or
unknown. Held wins over everything. Unheld needs every roster read
whole and none holding the id. No folder, no rosters, a named hostKey
with no roster, or any unreadable or malformed roster answer unknown.
A reaper deletes only on unheld.

## Migration Gate

tests/package/session-state-is-keyed.test.ts detects direct process.pid,
process.cwd(), processGlobal(), Symbol.for(), globalThis member access
and process.env writes in extensions. It parses syntax, ignoring
comments and strings; it is not alias/data-flow analysis.

Today's sites wait in tests/package/session-state-waiting.txt, by
extension file and kind. Lower the count in the same change that
migrates a site, removing zero entries. New shortcuts fail. A genuine
process-wide service needs a reviewed exemption rather than a session
slot: its owner moves it to tests/package/session-state-exempt.txt as
`path:kind count reason`, and a line without a reason, or a count the
file outgrows, fails.

The waiting list is empty, so package.json declares
`pi.sessionStateKeyed: true`. A host that honours it loads one copy of
each of the package's modules for every folder its conversations run
in, rather than a copy per folder, so module state is shared by all of
them. The gate fails while the declaration stands and any site waits,
so a new site is keyed or exempted before it lands.
The gate does not scan library code: wave 2 owns its library migrations.
