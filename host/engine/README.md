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

SessionHost also puts a view in process.env's place, for code that reads
or writes it directly, such as Shopify's proxy extension, which builds
each request's attribution from it. Inside withSession, for a
conversation the host holds, every read, write, delete, key listing
and spread is that conversation's environment, and so is a child
started with no env of its own. Outside any conversation it is the
host's own. Work a released conversation left running reads the host's
env, and its writes and deletes are dropped, so a late write never
reaches what every other conversation falls back on. The proxy keys
(SHOPIFY_PROXY_KEY, PI_PROXY_API_KEY, PI_PROXY_AUTH_HEADER) always read
from the host's environment, since the engine resolves credentials per
request. A conversation that writes one keeps it in its own
environment, though its reads still come from the host. Dispose puts
process.env back.

harnessSettings builds each conversation's SHOPIFY_HARNESS_SETTINGS,
which ai-proxy-headers copies into every request's attribution. It
starts from the host's own value and says the pi version running the
conversation, its surface
(interactive when attended, else background) and launch mode (fresh
for an open, resume for an adopt, restore when a restarted host
carries it on). An open says whether it named the model and reasoning
level; otherwise the host's sources stand.

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
