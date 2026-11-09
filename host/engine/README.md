# Conversation Engine

The host's pi comes from its own install, never from this package's
dependencies: loadHostPi imports pi, pi-agent-core, pi-ai, pi-durable and
chord from the install's folder and refuses, naming each missing patch,
unless it carries every host seam core.nix's modules/pi applies
(the agent interface, the committed turn and the hosted screen). A host
refuses this before it opens any conversation.

SessionHost installs the public session seam before any hosted extension
loads. Register each conversation's stable pi id, absolute session file,
working folder, environment and cleanup callback before publishing leases.
The service keeps the durable restart roster; this module publishes only
live ownership at hostRegistryPath.

Run dispatches through withSession. Environment snapshots are independent
copies and PI_SESSION_ID is set to the conversation id. Launch hints are
consumed once. Closing stops new dispatch, parks the owner, waits for its
cleanup callback and then releases its slots and list entry. A failed
cleanup or publication keeps the owner held and refuses further dispatch;
a retry does not repeat cleanup that already completed. Sibling sessions
remain usable. Dispose refuses until the host has no conversations.

The cleanup callback must abort active work, emit pi's session_shutdown and
dispose timers, subscriptions and runner resources. The optional stamp
callback emits on the conversation's pi event bus: close sends closed;
stop sends signalled for host restart, without marking a deliberate quit.
Stamps do not recursively close. Reload keeps ownership and slots, not
calling close or stop: `reload(id, { reason })` runs the registration's
optional reload callback under withSession, joins a reload already
under way, refuses an unknown or closing conversation, a tree (`onto`)
and a runner with no callback, and leaves a conversation whose reload
failed held and usable.

## The Hosted Agent

Each conversation runs pi's own AgentSession. Only the agent under it
changes: pi's createAgentSession builds it through the agent-interface
patch's createAgent option. The agent is HostedAgent (hosted-agent.ts),
shaped as pi's Agent and run by the conversation's own durable harness,
which openHostedConversation (hosted-conversation.ts) opens on a SQLite
store of its own. pi keeps its state, queues, listeners, hooks, retry and
compaction, and every request is built from pi's projection of the
session. Durable admits inputs, makes each request through pi's stream
with the conversation's environment, and runs each tool, never rerunning
one a restart cut off. Nothing reaches pi before durable has committed
it, so the session file never holds a step twice, and ordinary pi opens
the file.

ToolRound (tool-round.ts) keeps pi's tool-call steps in pi's order:
start, then preparation, hooks and validation, then execution. A
parallel round prepares every call before any runs, as pi does. pi-types.ts
and durable-types.ts declare the narrow shapes the engine uses of pi's
JavaScript, and pi-library.ts picks pi's functions from the loaded
install. tests/host/engine/hosted-agent.test.ts holds the agent to pi's
own: ten scripted scenarios give pi's listeners identical events, and a
SIGKILL mid-tool resumes without a second run of the tool.

Process-child reconciliation and createEngine, the service's factory, are
subsequent work.
