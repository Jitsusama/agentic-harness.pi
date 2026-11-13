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
environment, though its reads still come from the host. What only the
host's process is (HOST_READS: the runtime's AI_PROXY_HEADERS_BIN and
WORKTRAIL_BIN, and the viewers' PI_IMAGE_PROTOCOL, PI_TRUE_COLOR and
PI_HYPERLINKS) is read from the host's environment, and sent with each
request, when the conversation names none, but never listed or spread.
So a command a conversation starts finds its own tools on PATH rather
than the runtime's older ones, and judges its own terminal. Dispose
puts process.env back.

harnessSettings builds each conversation's SHOPIFY_HARNESS_SETTINGS,
which ai-proxy-headers copies into every request's attribution. It
starts from the host's own value and says the pi version running the
conversation, its surface
(interactive when attended, else background) and launch mode (fresh
for an open, resume for an adopt, restore when a restarted host
carries it on). An open says whether it named the model and reasoning
level; otherwise the host's sources stand. The engine passes the
version of the pi it loaded, since nothing under host/ imports a pi
package except for its types: the host runs pi from its own pinned
install, and the harness's production install carries none
(tests/package/host-imports-no-pi.test.ts holds it).

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
failed held and usable. The engine's callback waits for the run to end,
then reloads through the conversation's screen when it has one
(`screens.reload`, its pi's /reload), and the session itself only when
nothing draws what the extensions put on a screen.

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
parallel round prepares every call before any runs, as pi does. It also
scrubs credentials from each streamed update and from the result it
ends a call with, so viewers and the durable store never hold one; pi's
afterToolCall still sees the raw result, and a result with nothing to
hide passes as the same object. pi-types.ts
and durable-types.ts declare the narrow shapes the engine uses of pi's
JavaScript, and pi-library.ts picks pi's functions from the loaded
install. tests/host/engine/hosted-agent.test.ts holds the agent to pi's
own: ten scripted scenarios give pi's listeners identical events, and a
SIGKILL mid-tool resumes without a second run of the tool.

Every run, durable hook, request, tool call and listener of pi's runs as
the conversation's own (withSession), whoever scheduled it, so what reads
the ambient conversation, the process environment's view among them, sees
this one. A request the gateway refuses with a 401 goes once more when
the key has been renewed (renewing-stream.ts), since pi retries no 401.

## The Engine

createEngine (engine.ts) is the service's engine, made from and answering
what contract.ts declares; resources.ts turns the resources pi's flags
would choose into pi's loader options, and requests.ts reads what an open
or adopt names. It loads the host's pi
(host-pi.ts refuses one lacking any host patch), pins that pi as the
install every conversation's subagents run (subagent-install.ts), since
the host's own script is no pi to launch, and builds each
conversation with pi's own runtime (pi-session.ts declares what it uses).
A conversation is registered with SessionHost, then its extensions load,
bound by its screen or, with none, as pi's RPC mode binds them
(headless.ts), its session is built and its first words are sent, all
under its id.
Its model runtime reads keys through an auth context over the
conversation's own environment (auth-context.ts, and the auth-context
patch), never the host's. The engine writes a new conversation's session
header itself, since pi writes a file only once it holds an answer, so a
conversation stopped before one keeps its id when resumed.

A conversation's folder is trusted as pi's CLI trusts it
(project-trust.ts, on pi's own project-trust module): an answer the host
already gave that folder, then, where the folder holds what needs trust,
its extensions' project_trust handlers, pi's trust store and the default,
which is to ask. An attended conversation's start asks its screen
(askProjectTrust) and answers once it has asked, so a viewer can attach
to answer; its first words go in once the person has. With no screen to
ask, or unattended, a folder pi would ask about stays untrusted, and its
start warns that its own settings and extensions were not loaded. A close
while asking settles the question and builds nothing more.

An open answers once its first words are durable, so a failed prompt
fails the open, except while something waits on the person no viewer can
yet reach: the trust question, an extension command, or a dialog its
screen says is open (the asking signal handed to opened), such as an
extension's input handler asking before the words go on. Then it answers
at once, and what fails after is reported and handed to the screen
(failed), which shows it as pi shows an initial message's error.

A close aborts what runs and stamps `closed`. A stop parks the agent and
stamps `signalled`, leaving what durable had in flight for the next
start, whose resume carries it on. A conversation park-workflow parks
while idle (`Host.park`) is stopped the same way, so the service keeps
its hold, and its screen keeps its viewers (`parked`). parking.ts
watches the wake file each conversation is told of in MYCELIUM_WAKE
and asks the service to wake it (`ConversationEvents.wake`) when it is
written or a viewer types; a wake asked while it is still parking
waits for the park to settle, and a close then waits too, closing it as
a parked one. It watches the wake file until a resume has begun, so a
wake that fails leaves it to the next. A wake through the file that is
refused is kept beside it as `wake.refused`, with the message that asked
and why (lib/internal/session/refused-wake.ts), so the mesh can say why
it sleeps on; the conversation's next start or its close clears it. A
host starting leaves parked what its last process parked this boot,
plain pi's marker still naming this host's wake file
(`restsParked`): it builds nothing, watches the wake file as the park
did, and a wake written while the host was down wakes it once the host
listens. Any other it resumes clearing the marker, so the conversation
counts idle from its log and parks again at its first look. While a conversation is parked, parked-warming.ts keeps its
cache entry warm from the carry its session's warming wrote as it
parked (lib/internal/warming-carry.ts): on the session's schedule, at
most four warms in all, through pi's model runtime with the
conversation's key, each kept for the session's next start to record.
A resume stops it before the session starts and takes the carry, and a
warm out then is dropped rather than holding the wake up.
quiet-collection.ts gives V8's pooled pages back with one last-resort
collection, which unmaps the pages V8 keeps until a memory-reducing
one, once something has stirred (a turn started or ended, or a
conversation was let go) and the host is quiet: no tool call or job
running, and no viewer's key or resize for 30 s. A conversation
mid-turn that only waits on the model doesn't hold it off, since the
attended host almost always has one, and the pause costs it at most a
stall in streaming. It runs at most once in 10 minutes, and a park may
bring one forward inside them. A host that always has a job running
would never be quiet, so once a collection has been due an hour it
runs with tool calls and jobs running, still after 30 s with no key
or resize, and says how many of each were. Where V8 exposes no gc it
says so once and collects nothing, rather than refusing to start. The
journal line says the pause in ms,
the Pss before and after and how many conversations were waiting on
the model, and names a pause over a second as the loop held, as the
watchdog names a late beat. The `host` section of the package's config
file turns it off with `collectWhenQuiet: false` (service/settings.ts). Given
screens, the engine hands each built conversation to them; without, it
binds extensions with no interface, as pi's RPC mode does. tests/host/engine/engine.test.ts runs a
host's life a start at a time.

A conversation's environment is the realm's, then its launch, then what
the engine derives each start. The launch is what conversationEnv says
when it opens or is adopted; prepare returns it, the service's roster
holds it, and a resume replays it as held. The service's says the
request's `env`: the fence and spawner variables of the session it
continues (lib/internal/session/carried-environment.ts), so a fenced
session that moves into a host runs its commands fenced there too. Each start the engine sets
SHOPIFY_HARNESS_SETTINGS (harness-settings.ts) from the host's value,
the conversation's traits and the loaded pi's version, and the
markers naming the conversation, the host's key and the host process
(PI_HOST_CONVERSATION, PI_HOST_KEY, PI_HOST_OWNER); none is stored.

pi's bash tool runs each command as its own process group, and a host
killed mid-tool leaves it running. Every command inherits the markers,
so each start and end of a conversation ends every process carrying its
marker, by group (tool-children.ts), wherever it went. Before the
service resumes anything, creating the engine ends every process under
its key whose owning host, a pid and the tick it started at, no longer
runs: the conversations it will resume, and those it won't, such as one
the dead host was closing. A host holds its key alone, so a live host's
children are never touched. Neither reap touches a command a
conversation carried on, released to plain pi with it running: the
shell marks its kept files `.carried` with the call's own mark, and
every process carrying that mark, whatever group it moved to as
`timeout` does, is spared until the plain pi says its end.

A conversation can become another, by pi's /new, /fork, /resume or
import (replacement.ts). pi disposes the old session before it builds
the next, so a resume or import of a file the host holds is refused
first, while nothing is torn down. The next is held under its own id
before pi builds it: the service hears `became` and holds it in the old
one's place, then the engine registers it with the same launch, its own
settings and its own durable store, and writes its file as it does for
an open. Once pi is done the next takes the runtime and its screen on,
and the old one closes as `replaced`. If pi fails past its teardown,
both end. Whatever closes a conversation itself (its screen, an
extension, a replacement) is said to the service as `ended`; a host
stopping never is.
