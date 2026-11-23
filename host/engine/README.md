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
(SHOPIFY_PROXY_KEY, PI_PROXY_API_KEY, PI_PROXY_AUTH_HEADER) read from
the host's environment, since the engine resolves credentials per
request, except where a conversation's budget laid one (PI_BUDGET_KEYS
names it, budget-keys.ts): that one is the conversation's own, in its
reads, its requests and its subagents. A conversation that writes one
keeps it in its own environment, though its reads still come from the
host. What only the
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
(`tests/package/shipping/host-imports-no-pi.test.ts` holds it).

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
store of its own. A store's commits never checkpoint its log: one worker
per host does, PASSIVE, once the log passes 1,000 pages and again as the
store closes (checkpoints.ts), since a checkpoint's syncs wait on /home's
btrfs commits and would hold the host's one thread. What a run holds, the agent's state, the provider
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

A run the agent begins itself opens as a run of pi's
(hosted-agent/pi-runs.ts), through the runtime's runForHost seam, the
moment pi is first shown it: the recovery's, held open across any ask
again, and a run durable carries on alone. pi prepares it as a prompt's,
so every extension adds its sections at before_agent_start, and settles
it once it ends. Inside a run of pi's, the agent's run joins it; a run
pi is never shown opens nothing. Before it, a carried turn reached the
model without the harness's resident block, and job-workflow's outbox
held a job's result from a carried run until a person typed.

A start drops a hold whose session file is gone for good, as the
engine's `lost` says (pi-session.ts): only a file missing from a
folder that is there counts, so a disk not yet mounted or a file it
can't look at keeps its hold, and its resume says what is wrong.

A host coming back carries only a few cut-off runs on at once
(resume-turns.ts, RESUMED_RUNS_AT_ONCE, 4). As a start resumes what it
holds, each conversation whose durable store holds a run waits for a
turn before durable carries it on. It gives the turn back as the first
answer streamed after the restart ends, its own or the ask again's, or
after RESUMED_TURN_MS (60 s) at most, so a run that goes on for an hour
holds up neither the runs behind it nor words sent to them. Until the
start has resumed its last conversation it holds back every run Joel
doesn't wait on, so the order is the whole start's: a run he types or
steers into since the restart goes first, past the cap if it's full;
then, under the cap, runs his words began; then the rest in the order
they asked, roughly the order the host held them, once the start ends.
A peer's or the machine's steer, and words with the automated header,
are not his (resume-turns.ts, isJoelsWords). A run's place is read each
time a turn comes free and once a second while any waits, not once as
it asks. A wake, an open or an adopt takes no turn, an abort ends
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
install. `tests/host/engine/hosted-agent.test.ts` holds the agent to pi's
own: ten scripted scenarios give pi's listeners identical events, and a
SIGKILL mid-tool resumes without a second run of the tool.

Every run, durable hook, request, tool call and listener of pi's runs as
the conversation's own (withSession), whoever scheduled it, so what reads
the ambient conversation, the process environment's view among them, sees
this one. A request the gateway refuses with a 401 goes once more when
the key has been renewed (renewing-stream.ts), since pi retries no 401.

## The Engine

createEngine (engine.ts) is the service's engine, made from and answering
what contract.ts declares. engine.ts holds a conversation's steps in the
order each relies on (register, begin, end, release) and its answers to
the service. How pi builds, replaces and loses a conversation's session
is conversation-build.ts. What its requests need (its environment, on
its budget's key or the host's) and keep past a park (its agent folder and providers) is
kept-requests.ts. What a stop keeps, a close ends and a restart would
end is stopping.ts. resources.ts turns the resources pi's flags would
choose into pi's loader options, and requests.ts reads what an open
or adopt names. It loads the host's pi
(host-pi.ts refuses one lacking any host patch), pins that pi as the
install every conversation's subagents run (subagent-install.ts), since
the host's own script is no pi to launch, and builds each
conversation with pi's own runtime (pi-session.ts declares what it uses,
and judges whether a held conversation's session file is gone).
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

Trust alone isn't enough for code a folder's .pi holds, which pi runs
outside the agents' sandbox: its extensions, MCP servers, installed
packages and the settings that start a program (project-code.ts). A
fenced command could write them into any folder under a trusted one,
and the next build or reload would run them unfenced. So the host pins
each folder's code, by its contents, in project-code.json in pi's agent
folder, which the sandbox holds read-only. Once a .pi holds code, every
file in it counts, since an extension may run what a file beside it
says, as are the files its settings name as extensions or packages,
wherever they are; skills, prompts, themes and the system prompt files
are words pi reads, and stay under pi's trust alone. Code there at the
host's first look is pinned as found, by its files' ctime, which
nothing in userspace can set back. Code once allowed loads in any
folder that holds the same, so a new tree of the same branch doesn't
ask. New or changed code asks an attended start's screen first (Load
it, as you would any program you run?), naming its files the newest
first, and a yes pins it, unless the code changed while the question
waited. Unattended, or at a later load, the folder loads untrusted and
the journal says why, and a reload trusts it again once its code is
pinned again. A later load, such as a /reload, tells its screen
nothing: the folder's extensions leave it without a word there, and
only the journal says why. Every load
begins with pi reloading the settings, so the check runs there, before
a reload's resources too. A .pi too large to check (past 10,000
entries, 64 MiB or folders 24 deep), or holding a pipe or a device,
never loads its code, nor does a .pi package installed with its
dependencies, which outgrows those limits at once; pins that can't be
read pin nothing, and what's said names the pins file rather than the
code; and a
folder pi doesn't ask trust for, or that the person said not to trust,
is never asked about, though a conversation still trusted from before
the no is checked at each load.

What the pins don't cover: code outside .pi that pinned code imports
or runs, such as a linter an extension starts from the repository; a
file in .pi an extension already loaded reads again before the next
load, which the check sees only then; a change between the check and
pi's reading of the file, which a fenced command swapping a file to
and fro can try at every reload the model asks for, since the guard
gives trust back each time it reads the pinned contents again; two
hosts writing the pins at once, where the last write wins; the
hand-kept lists of pi's code entries and code settings, which a new
pi may outgrow; a plain pi outside the host, which doesn't check the
pins; and the subagent tool, whose pi runs outside the fence and
loads the extensions the model names to it, or a trusted folder's
.pi when not isolated, with no pins checked.

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
and why (`lib/internal/session/refused-wake.ts`), so the mesh can say why
it sleeps on; the conversation's next start or its close clears it.
While it rests, parking.ts also watches the steer inbox of each address
its park marker names (`lib/mesh/parked.ts`), and wakes it the same
way as soon as a talk, close, carry, move, fill or answer lands, rather
than at the mesh's once-a-minute pass, which stays as the backstop.
Where a park keeps carried bash calls (a shared host with a jobs
cgroup, or spawners in scopes of their own), it stops the conversation
carrying them as a restart does; parked-calls.ts writes the calls the
conversation's bus said it carried to `carried-calls.json` beside its
wake file, and whoever watches that wake looks at them every five
seconds, rolling their output as the conversation would, and writing
the wake file once none still runs. Any doubt wakes it, since a woken
conversation takes its calls up again and holds them or times them
out: a call past its own time limit or a day old counts as ended, a
record that can't be written wakes it as it parks, a wake refused is
asked again after five minutes and then twice as long each time up to
an hour until it runs, and a wake file that can't be written is tried
again at each look. The record stands until a resume runs (`ran`), so
a start that fails watches on; closing the conversation for good,
held but not running or not, stops the calls, and a release leaves
them to the next holder, taking them off what this host's own restart
would keep. `PI_PARK_CARRY=off` turns the
carry off, parking as before it. Where it falls short: a host unit
that dies wakes every carried conversation at once as it starts, and
a restart's carry landing in the same moment as a park's can record
the calls twice, which only wakes once. A
host starting leaves parked what its last process parked this boot,
plain pi's marker still naming this host's wake file
(`restsParked`): it builds nothing, watches the wake file as the park
did, and a wake written while the host was down wakes it once the host
listens. Any other it resumes clearing the marker, so the conversation
counts idle from its log and parks again at its first look. While a conversation is parked, parked-warming.ts keeps its
cache entry warm, on what kept-requests.ts kept of it, from the carry its session's warming wrote as it
parked (`lib/internal/cache/warming-carry.ts`): on the session's schedule, at
most four warms in all, through pi's model runtime with the
conversation's key, each kept for the session's next start to record.
It reads and writes each carry off the host's thread, since a carry
holds the whole conversation and a slow disk held the loop for seconds.
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
kept-history.ts has a conversation pi opens from a compacted log hold
only what a rollover would keep of it: the entries from the last
compaction's first kept entry on, and the state from before it. A log
of 98.6 MB held 142 MB of heap whole, against 30 MB for that view
(126 MB against 14 over a bare session's). The file and session id
stay as they are, so the roster, socket, store and mesh address do
too. A rollover record that is never written names the same file as
its parent and carries the spend and first prompt of the turns left
on disk, so session_recall, the spend total and the compaction
trigger read as before, and compaction quotes read back what they need
from the file; usage entries,
never written either, carry their tokens and cost for pi's footer and
/session; and every id in the file stays taken. The tree, a fork, a
lookup of an entry left on disk, a branch to one from before the last
compaction and a rewrite of the file read the whole log back first,
each said in the journal; a switch to another log lets the view go. It
holds on a resume, a wake, an adoption and a replacement by an older
log, and leaves pi's full open alone when anything fails or pi's
privates aren't what it reads.
kept-history-session.ts has each session pi builds count and list the
messages a held log left on disk: /session's message counts add the
ones the view counted as it held, and /fork's list reads the log's
user messages a line at a time when asked, in the order pi lists them
from a whole open. It wraps the session instance only, answers as pi
does once the view lets go, and offers pi's own list, said once, when
the log can't be read.
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
left uncollected and said, until the heap falls within it. A child,
holding one conversation, forgets a pace an hour after its collection
and then collects to measure afresh, so one pause slowed by swap can't
skip every later look; the shared host keeps its paces, since there a
long pause stalls every conversation. The `host` section of the package's config
file turns it off with `collectWhenQuiet: false` (service/settings.ts). Given
screens, the engine hands each built conversation to them; without, it
binds extensions with no interface, as pi's RPC mode does.
`tests/host/engine/engine.test.ts` runs a host's life a start at a time.

A conversation's environment is the realm's, then its launch, then what
the engine derives each start. The launch is what conversationEnv says
when it opens or is adopted; prepare returns it, the service's roster
holds it, and a resume replays it as held. The service's says the
request's `env`: the fence and spawner variables of the session it
continues (`lib/internal/session/carried-environment.ts`), so a fenced
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

A park, or any stop of the host's (for a restart or for good), keeps
what the conversation's ended commands left running, as plain pi
does while its session idles, such as a build started with `&`
(stopping.ts, noting it through left-running.ts). By then any call still running was signalled and
ended what it left, or is carried to the next host and left out, so
the stop notes the `PI_BASH_CALL` mark of each process still carrying
the conversation's marker, but for the mark its whole environment
carries. It writes them to `left-running.json` in its state folder, and
says so in the journal. Every reap after spares them for a day: the
stop's own, the wake's and the next host's at its start. What an
extension started carries no call's mark and ends with the stop. A
release to another holder, or pi replacing the conversation in its
seat, hands it on and keeps the same way. A close for good, parked or
running, drops the conversation's notes and ends what its parks kept,
saying so in the journal. A crash or a kill -9 notes nothing, so what
they cut ends as before.

A host's own restart carries its conversations' bash calls the same
way, to the next host (carried-shells.ts), and so does any other stop
where the engine can keep them (`carries`). The service stops each
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
in the journal. On Linux with systemd-run and a user manager, a host's
pi-spawners each run in a scope of their own
(`lib/internal/shell/spawner-scope.ts`), so its calls already sit
outside the unit: nothing is moved, and they are kept all the same.
Without a jobs cgroup or such a scope nothing is kept, and a bash call
holds the restart as every other job does. A host killed before its
stop finishes carries nothing this way; each conversation recorded its
running bash calls beside their kept files as they started
(`lib/internal/shell/kept-jobs.ts`), so the next host's reap spares a
call whose shell still runs, within its time limit and a day, and the
conversation takes it up as it resumes; one nobody takes up is stopped
on the look at strays once its time limit or a day has passed.
`background` counts only
what a restart would end, and `holding` names it, for the journal
line a restart held past its ceiling writes once an hour.

A conversation can become another, by pi's /new, /fork, /resume or
import (replacement.ts, settled in conversation-build.ts). pi disposes the old session before it builds
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

## Its Files

Many entries because each of the engine's concerns (building a
conversation, its screen, its store, its stop, its tool children, its
checkpoints, the session seam) is a file of its own beside engine.ts,
which brings them together and imports nearly all of them. Only the
hosted agent, whose files change together, has a folder of its own.
