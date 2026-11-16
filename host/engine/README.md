# Conversation Engine

The host's pi comes from its own install, never from this package's
dependencies: loadHostPi imports pi, pi-agent-core, pi-ai, pi-durable and
chord from the install's folder and refuses, naming each missing patch,
unless it carries every host seam core.nix's modules/pi applies
(the agent interface, the committed turn and the hosted screen). A host
refuses this before it opens any conversation. A seam it only wants
(HOST_WANTED_SEAMS) is listed in lacking instead, and the host says at
start what it goes without, so a runtime built before one still hosts.

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
store of its own. What a run holds, the agent's state, the provider
stream, durable's transcript mirrored to pi, pi's turns around each
request, the queued words given to durable and the recovery live beside
it in hosted-agent/. pi keeps its state, queues, listeners, hooks, retry and
compaction, and every request is built from pi's projection of the
session. Durable admits inputs, makes each request through pi's stream
with the conversation's environment, and runs each tool, never rerunning
one a restart cut off. Nothing reaches pi before durable has committed
it, so the session file never holds a step twice, and ordinary pi opens
the file. A request a restart cut off is asked again: durable,
whose own retry stays off, ends that run as interrupted, and the
recovery then continues the conversation, unless durable ended it for
being cut off again and again.

pi tells its extensions agent_settled only when a run it began ends, so
the agent tells them itself when one of its own ends
(hosted-agent/settles.ts): the recovery's, once any ask again is over
too, and a run durable carries on alone. It says nothing while a run of
pi's is under way, which settles as pi's run ends, nor for a run pi was
never shown. Without it, job-workflow's outbox held a job's result from
a carried run until a person typed.

A host coming back carries only a few cut-off runs on at once
(resume-turns.ts, RESUMED_RUNS_AT_ONCE, 4). As a start resumes what it
holds, each conversation whose durable store holds a run waits for a
turn before durable carries it on. It gives the turn back as the first
answer streamed after the restart ends, its own or the ask again's, or
after RESUMED_TURN_MS (60 s) at most, so a run that goes on for an hour
holds up neither the runs behind it nor words sent to them. Every turn
is held until the start has resumed its last conversation, so the order
is the whole start's: runs begun by words a person typed first, and any
a person types into while it waits, then the rest in the order the host
held them. A run's place is read each time a turn comes free, not once
as it asks. A wake, an open or an adopt takes no turn, an abort ends
the wait, and a park leaves the run in durable for the start that opens
it next. Words typed while a run waits queue behind it, and when the
recovery ends into the ask again for a cut-off request, pi's session
follows that run rather than failing as the agent already processing.

pi's session writes an extension's message at once when it counts no
run of its own, and a turn durable carries on after a restart is not
one, so a mesh message could land between a call and its result, and
providers that check order then refuse every request. The engine has
each session hold such a message through that turn as pi holds one
through its own run (carried-turn-messages.ts): steered in when it asks
for a turn, written once the turn ends when it doesn't, or as the
session is disposed if the host stops first. Each request
also has its tool results put back beside their calls first
(paired-results.ts), which keeps a file already in that shape
answering; a result whose call is not before it goes as text saying so.

Words sent as a conversation reopens wait behind the turn durable carries
on, queued on the agent rather than on pi's session, whose screen lists
only what it queued itself: queueing them there too would run them through
the extensions' input handlers and onto the agent a second time. So the
agent shows them through the agent-interface patch's showQueued
(joinSession), and pi takes each off its list as its message starts or
the queue is cleared. On a pi without that seam they show only as their
turn starts.

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
it sleeps on; the conversation's next start or its close clears it.
While it rests, parking.ts also watches the steer inbox of each address
its park marker names (lib/mesh/parked.ts), and wakes it the same
way as soon as a talk, close, carry, move, fill or answer lands, rather
than at the mesh's once-a-minute pass, which stays as the backstop. A
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
A warm's runtime loads no extensions, so kept-providers.ts keeps what
the conversation's extensions registered of its providers as it parks
(Shopify's proxy registers anthropic with its address, key variable and
headers) and registers it on each warm's runtime. It is kept in memory
and, where it is plain data, in `providers.json` beside the
conversation's store, for the next host's warms of one resting parked.
The file names a key only by its variable and holds no header named as
a credential, so a provider whose key was written out warms in this
host alone.
A resume stops it before the session starts and takes the carry, and a
warm out then is dropped rather than holding the wake up.
While the host holds a conversation, running or parked, held-logs.ts
holds its log open read-only, so a reader of the machine can tell the
host that holds a conversation from one that only once said it did:
mycelium believes a claim to own a session only where its owner holds
that log open, and a host that died holds none. It opens as pi builds
the session, once keptFile has written the log, and as a host starting
leaves one resting parked. A conversation that becomes another (a /new,
a fork, a rollover) holds the log it became, and the one it was lets
its log go as it ends. A park keeps it; a close, a stop for a restart,
a failed replacement and a drop while parked let it go.
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
watchdog names a late beat. Its pause grows with the heap, about a
second a GB on the live hosts, so a collection whose heap, at the
slowest pace of the last four, would hold the loop past a second is
left uncollected and said, until the heap falls within it. The `host` section of the package's config
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

A park keeps what the conversation's ended commands left running, as
plain pi does while its session idles, such as a build started with
`&` (left-running.ts). By then any call still running was signalled
and ended what it left, so the park notes the `PI_BASH_CALL` mark of
each process still carrying the conversation's marker. It writes them
to `left-running.json` in its state folder, and says so in the
journal. Every reap after spares them for a day: the park's own, the
wake's and the next host's at its start. What an extension started
carries no call's mark and ends with the park. A close, a crash or a
kill -9 notes nothing, so what they cut ends as before.

A host's own restart carries its conversations' bash calls the same
way, to the next host (carried-shells.ts). The service stops each
conversation with `restarting`, whose callback tells its bus
(`agentic-harness:host-restarting`) before the stamp, and job-workflow
says what it carried. Once every conversation has parked, the engine
moves each carried call's processes still in the host's own cgroup,
matched by the call's `PI_BASH_CALL` mark and never by a pattern, into
the cgroup `JOBS_CGROUP` names, so the unit's stop never reaches them;
a moved process then sits under that unit's limits and ends with its
stop. It writes them to `carried-shells.json` in its state folder, and
the next host stops one no conversation took up once its time limit
passes or a day after the restart, whichever comes first, saying so
in the journal. Without a jobs cgroup nothing is kept, and a bash call
holds the restart as every other job does. `background` counts only
what a restart would end, and `holding` names it, for the journal
line a restart held past its ceiling writes once an hour.

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
