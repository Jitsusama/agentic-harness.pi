// The soak: a week's turns through one host, then the same turns through plain pi, and what each side's memory, latency and records say.
/**
 * Run on a lent builder, never on a laptop someone uses (README.md says
 * how). Each conversation's turns are typed through viewers that attach
 * for a visit of a few turns and leave, a second one joining every third
 * visit, and include reads, bash, background bash jobs and long answers.
 * Each conversation's first key waits a seeded draw within one median
 * turn at the pace, on either side, so they start as a person comes to
 * them rather than in the same instant.
 * At each checkpoint every conversation stops: the host is weighed awake,
 * the park switch names them all, the host is weighed once they have
 * parked, and each is woken again, by a window, by the mesh or by the
 * next key typed, in turn; with --burst every one is woken by a window
 * at the same moment instead, as a host's conversations wake together
 * after a switch, and the host is weighed again once all have. Then plain pi takes the same turns, one RPC
 * process a conversation, all at once as the host's were.
 *
 *   node tests/host/soak/soak.mts --turns 120,40,40,... [--checkpoints 8]
 *     [--no-park] [--burst] [--profile] [--answer-ms P50[,P90]]
 *     [--tool-ms P50[,P90]] [--rounds P50[,P90]] [--out DIR]
 *
 * With --profile each side's node writes a CPU profile, and the report
 * says where each side's time went. Without a pace the model answers at
 * once and every side runs as fast as it can; --answer-ms has each answer
 * take a time drawn through those percentiles, streamed in pieces, and
 * --tool-ms has each bash command run that long, and --rounds has each
 * turn work through that many rounds of tool calls, as a real week's
 * sessions do. The report says the pace it ran at.
 *
 * It needs a pi with the host's patches, as test:host does
 * (PI_HOST_RUNTIME), and prints the report as one JSON line after
 * `soak report:`, writing it to DIR/report.json too. A lender can drop a
 * run of hours before its end, so what the report would hold is said as
 * it is known: each weighing and the hosted turns' latency so far at each
 * checkpoint, the hosted side's latency and time spent once it is done,
 * and each plain conversation's latency as it ends.
 */
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../../../lib/internal/record.ts";
import { askWake } from "../../../lib/internal/session/park.ts";
import { type Folders, folders } from "../end-to-end/support/folders.ts";
import {
	hostPackageDir,
	hostPiMissing,
} from "../end-to-end/support/host-pi.ts";
import {
	type ScreenHost,
	startScreenHost,
	type Weight,
} from "../end-to-end/support/screen-host.ts";
import { type Seal, seal } from "../end-to-end/support/seal.ts";
import { attach, type Viewer } from "../end-to-end/support/viewer.ts";
import { type RpcEvent, rpcClient } from "../parity/rpc-client.ts";
import {
	LONGEST_MS,
	MOST_ROUNDS,
	medianTurnMs,
	paceOf,
	staggerOf,
} from "./pace.ts";
import {
	longestLived,
	type Pinned,
	timeSpent,
	timeSpentWithin,
} from "./profile.ts";
import {
	barOf,
	entriesOf,
	growthOf,
	latencies,
	pairedCost,
	pairSteps,
	parityOf,
	type ScreenSplit,
	type SlowKey,
	type Spread,
	screenSplit,
	showsTag,
	slowKeys,
	slowSteps,
	spreadOf,
	stepCostOf,
	stepsOf,
	type Typed,
	turnRecords,
	turnTimes,
} from "./report.ts";
import {
	JOB_SAYS,
	type SoakProvider,
	soakProvider,
	textOf,
} from "./soak-provider.ts";
import {
	acknowledged,
	checkpointsOf,
	type Turn,
	turnsOf,
	visitsOf,
} from "./turns.ts";

/** How long one turn may take on a loaded builder, every extension loaded. */
const TURN_MS = 120_000;
/** A key slower than this to reach its log is named, the bar a held loop is held to. */
const SLOW_KEY_MS = 1000;
/** How many of the slowest keys the report names. */
const MOST_SLOW_KEYS = 20;
/** How many of the costliest rounds and tools the report names. */
const MOST_SLOW_STEPS = 10;
/** park-workflow's two minutes for a named session, its minute between looks, and room for load. */
const PARK_MS = 4 * 60_000;
/** How often a parked host is weighed again while it still holds a session. */
const REWEIGH_EVERY_MS = 5_000;
/** How long a viewer may take to draw its first frame. */
const DRAWN_MS = 30_000;
/** How often a viewer's frames are looked through for a prompt just typed. */
const SHOWN_LOOK_MS = 5;
/** How long past a turn's going idle its answer may take to be drawn. */
const DRAWN_AFTER_IDLE_MS = 5_000;
/** How often a turn's end is looked for in its log. */
const LOOK_EVERY_MS = 100;
/** How much of a log's end a look reads: more than any one answer. */
const TAIL_BYTES = 64 * 1024;
/** A run with more faults than this stops, as its turns no longer say anything. */
const MOST_FAULTS = 20;
/** How much of what the host wrote a fault quotes. */
const SAID_CHARACTERS = 2000;
/** A share as a checkpoint line says it. */
const PERCENT = 100;
/** How many of a log's last entries a fault names. */
const LAST_ENTRIES = 6;
/** How much of each named entry's words a fault quotes. */
const LAST_WORDS = 80;
const ROWS = 30;
const COLUMNS = 100;
const ENTER = "\r";
/** The extensions the fixture loads in every conversation already. */
const FIXTURE_LOADS = new Set([
	"panel-lifecycle-workflow",
	"panel-zoom-widget",
	"park-workflow",
]);
const HARNESS = resolve(import.meta.dirname, "../../..");

/** A weighing at a checkpoint. */
interface Checkpoint {
	readonly turnsDone: number;
	readonly atMs: number;
	readonly awake: Weight;
	readonly parked?: Weight;
	/** The bytes every conversation's log holds. */
	readonly recordBytes: number;
	/** How long the last conversation took to park. */
	readonly parkMs?: number;
	/** Each window's wake, one at a time, before the others wake. */
	readonly windowWakes?: readonly WindowWake[];
	/** Under --burst, every conversation's wake by a window, all at once. */
	readonly burstWakes?: readonly WindowWake[];
	/** Under --burst, the host once all have woken: its loop, through the burst. */
	readonly afterBurst?: Weight;
}

/**
 * A window opened on a parked conversation: the host's answer to its
 * attach waits for the whole wake, so `answeredMs` is the wake, and
 * `drawnMs` the screen's first words after it.
 */
interface WindowWake {
	readonly conversation: number;
	/** The bytes its log held, which its wake reads. */
	readonly recordBytes: number;
	readonly answeredMs: number;
	readonly drawnMs: number;
}

/** A conversation of the run, on one side. */
interface Conversation {
	readonly index: number;
	readonly cwd: string;
	sessionId: string;
	file: string;
	readonly turns: readonly Turn[];
}

const { values } = parseArgs({
	options: {
		turns: { type: "string" },
		checkpoints: { type: "string", default: "8" },
		"no-park": { type: "boolean", default: false },
		burst: { type: "boolean", default: false },
		profile: { type: "boolean", default: false },
		"answer-ms": { type: "string" },
		"tool-ms": { type: "string" },
		rounds: { type: "string" },
		out: { type: "string" },
	},
});
const counts = (values.turns ?? "")
	.split(",")
	.filter((one) => one !== "")
	.map(Number);
const checkpoints = Number(values.checkpoints);
if (counts.length === 0 || counts.some((n) => !(n >= checkpoints)))
	throw new Error(
		`usage: soak.mts --turns N,N,... each at least --checkpoints, ${checkpoints}`,
	);
const packageDir = hostPackageDir();
if (!packageDir) throw new Error(hostPiMissing());
const out = values.out ?? join(process.cwd(), "soak-out");
mkdirSync(out, { recursive: true });
const faults: string[] = [];
const fault = (what: string) => {
	faults.push(what);
	appendFileSync(join(out, "faults.log"), `${what}\n`);
	if (faults.length > MOST_FAULTS)
		throw new Error(`more than ${MOST_FAULTS} faults: ${faults.join("; ")}`);
};
const say = (line: string) =>
	process.stdout.write(`soak ${new Date().toISOString()} ${line}\n`);
/** When each hosted turn's prompt was typed and its answer drawn, by tag. */
const typedAt = new Map<string, Typed>();
const profiles = {
	hosted: join(out, "profile-hosted"),
	plain: join(out, "profile-plain"),
};

const pace = {
	answer: paceOf(values["answer-ms"]),
	tool: paceOf(values["tool-ms"]),
	rounds: paceOf(values.rounds),
};
// A paced turn may take as long as its pace adds: an answer and a tool
// each round, and a turn's own two rounds when it has no more.
const turnMs =
	TURN_MS +
	(pace.rounds ? MOST_ROUNDS : 2) *
		((pace.answer ? LONGEST_MS : 0) + (pace.tool ? LONGEST_MS : 0));
// Each conversation's first key waits a draw within one median turn, on
// either side, so they start as a person comes to them, not at once.
const staggerMs = medianTurnMs(pace);
const provider = await soakProvider(pace);
const agent = agentOf(provider);
const also = readdirSync(join(HARNESS, "extensions"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !FIXTURE_LOADS.has(entry.name))
	.map((entry) => entry.name)
	.sort();
say(
	`${counts.length} conversations, ${sum(counts)} turns, ${also.length + 3} extensions`,
);

const hostSeal = await seal();
const hosted = await runHosted(hostSeal);
const hostedLatency = latencyOf(hosted.logs);
const hostedProfiles = values.profile ? profilesIn(profiles.hosted) : [];
const hostedTime = values.profile ? timeSpent(hostedProfiles) : undefined;
const slow = spentIn(
	hostedLatency.slowKeys,
	(key) => ({ from: key.keyAt, to: key.promptAt }),
	hostedProfiles,
	hosted.pinned,
);
say(`hosted latency ${JSON.stringify(hostedLatency)}`);
if (hostedTime) say(`hosted time spent ${JSON.stringify(hostedTime)}`);
say(`slow keys ${JSON.stringify(slow)}`);
say("hosted side done; plain pi next");
const plainSeal = await seal();
const plain = await runPlain(plainSeal);
say("plain side done");

const parkedWeights = hosted.checkpoints.flatMap((one) =>
	one.parked ? [one.parked] : [],
);
const plainLatencies = plain.logs.flatMap(latencies);
const pairing = pairSteps(
	hosted.logs.flatMap(stepsOf),
	plain.logs.flatMap(stepsOf),
);
const steps = stepCostOf(pairing);
const turnsTimed = turnRecords(
	hosted.logs.flatMap(turnTimes),
	plainLatencies,
	typedAt,
	pairing.steps,
);
const paired = pairedCost(turnsTimed);
const report = {
	conversations: counts.length,
	pace,
	turns: sum(counts),
	opened: hosted.opened,
	checkpoints: hosted.checkpoints,
	staggerMs,
	slowKeys: slow,
	slowSteps: spentIn(
		slowSteps(pairing, MOST_SLOW_STEPS),
		(step) => step,
		hostedProfiles,
		hosted.pinned,
	),
	heap: {
		parked: growthOf(parkedWeights.map((one) => one.heapKb)),
		awake: growthOf(hosted.checkpoints.map((one) => one.awake.heapKb)),
		rssParked: growthOf(parkedWeights.map((one) => one.rss)),
		rssAwake: growthOf(hosted.checkpoints.map((one) => one.awake.rss)),
		heapTotalParked: growthOf(parkedWeights.map((one) => one.heapTotalKb)),
		heapTotalAwake: growthOf(
			hosted.checkpoints.map((one) => one.awake.heapTotalKb),
		),
		heldWhileParked: parkedWeights.map((one) => one.sessions.length),
	},
	latency: {
		hosted: hostedLatency.hosted,
		plain: spreadOf(plainLatencies.map((one) => one.ms)),
		paired,
		steps,
		screen: hostedLatency.screen,
		bar: barOf(steps, hostedLatency.screen),
	},
	turnsTimed,
	...(hostedTime
		? {
				timeSpent: {
					hosted: hostedTime,
					plain: timeSpent(profilesIn(profiles.plain)),
				},
			}
		: {}),
	parity: hosted.logs.map((log, at) =>
		parityOf(log, plain.logs[at] ?? [], {
			hosted: hostSeal.root,
			plain: plainSeal.root,
		}),
	),
	requests: provider.answered(),
	faults,
	hostErrors: errorsIn(hosted.errors),
	plainErrors: plain.errors.flatMap(errorsIn),
};
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`soak report: ${JSON.stringify(report)}\n`);
await provider.close();
await hostSeal.dispose();
await plainSeal.dispose();

/** The hosted turns' latency in the engine, and what the screens add to it, from their logs. */
function latencyOf(logs: readonly Record<string, unknown>[][]): {
	readonly hosted: Spread;
	readonly screen: ScreenSplit;
	readonly slowKeys: readonly SlowKey[];
} {
	const turns = logs.flatMap(turnTimes);
	return {
		hosted: spreadOf(logs.flatMap(latencies).map((one) => one.ms)),
		screen: screenSplit(turns, typedAt),
		slowKeys: slowKeys(turns, typedAt, SLOW_KEY_MS, MOST_SLOW_KEYS),
	};
}

/**
 * Each of `items`, a slow key or a costly step, with where the host's
 * time went within its stretch, from the profile of the host's own
 * process, which lived longest; without --profile, the items alone.
 */
function spentIn<T extends object>(
	items: readonly T[],
	stretchOf: (item: T) => { readonly from: number; readonly to: number },
	hostProfiles: readonly unknown[],
	pinned: Pinned,
): readonly object[] {
	const host = longestLived(hostProfiles);
	if (host === undefined) return items;
	return items.map((item) => {
		const { from, to } = stretchOf(item);
		return { ...item, spent: timeSpentWithin(host, pinned, { from, to }) };
	});
}

/** The agent folder's additions both sides take: the soak's model as the default, with no compaction or retry, so every request is the script's. */
function agentOf(listening: SoakProvider): {
	readonly providers: object;
	readonly settings: object;
} {
	return {
		providers: {
			soak: {
				baseUrl: listening.endpoint,
				api: "anthropic-messages",
				apiKey: "local-soak-no-secret",
				models: [
					{
						id: "mock",
						name: "Soak Mock",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 8192,
					},
				],
			},
		},
		settings: {
			defaultProvider: "soak",
			defaultModel: "mock",
			quietStartup: true,
			compaction: { enabled: false },
			retry: { enabled: false },
			// As on optimus: the harness's codemode stands in for pi's own.
			extensions: ["-builtin:codemode"],
		},
	};
}

/** The hosted side: every conversation in one host, with its checkpoints. */
async function runHosted(sealed: Seal): Promise<{
	/** The loop while every conversation opened, kept apart from the first checkpoint's. */
	readonly opened: { readonly ms: number; readonly weight: Weight };
	readonly checkpoints: readonly Checkpoint[];
	readonly logs: readonly Record<string, unknown>[][];
	readonly errors: string;
	/** When the host's process started and ended, to lay its profile on the wall clock. */
	readonly pinned: Pinned;
}> {
	const agentFile = join(sealed.root, "soak-agent.json");
	writeFileSync(agentFile, JSON.stringify(agent));
	const startedAt = Date.now();
	const host = await startScreenHost(
		{ ...sealed, env: profiled(sealed.env, profiles.hosted) },
		packageDir ?? "",
		also,
		agentFile,
	);
	const work = folders(sealed);
	const conversations: Conversation[] = [];
	const opening = Date.now();
	for (const [index, count] of counts.entries()) {
		const cwd = workingFolder(work);
		const { sessionId, file } = await host.open(cwd).catch((error: unknown) => {
			const said = host.errors().slice(-SAID_CHARACTERS);
			throw new Error(`opening ${index}: ${String(error)}: ${said}`);
		});
		say(`opened ${index} at ${Date.now() - opening} ms`);
		const turns = turnsOf(index, count);
		conversations.push({ index, cwd, sessionId, file, turns });
	}
	// Weighed here, the loop's figures since the host started are the
	// opening's alone, and the first checkpoint's start after it.
	const opened = { ms: Date.now() - opening, weight: await host.weigh() };
	say(
		`opened all ${conversations.length} in ${opened.ms} ms, ${loopOf(opened.weight)}`,
	);
	const parkFolder = join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"park-workflow",
	);
	const started = Date.now();
	const weighings: Checkpoint[] = [];
	/** Conversations left parked, for their next visit's first key to wake. */
	const byKey = new Set<string>();
	const barrier = barrierOf(conversations.length, async (done) => {
		const awake = await host.weigh();
		const recordBytes = sum(conversations.map((one) => sizeOf(one.file)));
		const soFar = latencyOf(
			conversations.map((one) => entriesOf(readOr(one.file))),
		);
		say(`latency so far ${JSON.stringify(soFar)}`);
		const atMs = () => Date.now() - started;
		if (values["no-park"]) {
			weighings.push({ turnsDone: done, atMs: atMs(), awake, recordBytes });
			say(
				`checkpoint ${weighings.length}: heap ${awake.heapKb} of ${awake.heapTotalKb} kB and RSS ${awake.rss} kB awake, ${loopOf(awake)}`,
			);
			return;
		}
		mkdirSync(parkFolder, { recursive: true });
		const switchFile = join(parkFolder, "switch");
		const ids = conversations.map((one) => one.sessionId);
		writeFileSync(switchFile, `${ids.join("\n")}\n`);
		const parking = Date.now();
		for (const id of ids)
			await tried(
				host.parked(id, PARK_MS),
				`${id} didn't park at ${done} turns`,
			);
		const parkMs = Date.now() - parking;
		const parked = await weighedOnceLetGo(host, ids, done);
		writeFileSync(switchFile, "");
		const checkpoint = weighings.length;
		const windowWakes: WindowWake[] = [];
		let burst: { wakes: WindowWake[]; after: Weight } | undefined;
		if (values.burst) {
			const wakes = await Promise.all(
				conversations.map((one) => windowWake(host, one)),
			);
			burst = { wakes, after: await host.weigh() };
		} else {
			for (const one of conversations)
				if (wakeOf(one, checkpoint) === "window")
					windowWakes.push(await windowWake(host, one));
			await Promise.all(
				conversations.map((one) =>
					wake(host, one, checkpoint, parkFolder, byKey),
				),
			);
		}
		weighings.push({
			turnsDone: done,
			atMs: atMs(),
			awake,
			parked,
			recordBytes,
			parkMs,
			windowWakes,
			...(burst ? { burstWakes: burst.wakes, afterBurst: burst.after } : {}),
		});
		say(
			`checkpoint ${weighings.length}: heap ${awake.heapKb} of ${awake.heapTotalKb} kB and RSS ${awake.rss} kB awake, heap ${parked.heapKb} of ${parked.heapTotalKb} kB and RSS ${parked.rss} kB parked, ${loopOf(awake)}${burst ? `; ${burstOf(burst.wakes, burst.after)}` : ""}`,
		);
		// Each weighing in full as it is taken, so a run cut short by its
		// lender's limit still leaves the memory curve it got to.
		say(`weighed ${JSON.stringify(weighings.at(-1))}`);
	});
	await Promise.all(
		conversations.map((one) => drive(host, one, barrier, byKey)),
	);
	const logs = conversations.map((one) => entriesOf(readOr(one.file)));
	const errors = host.errors();
	await host.stop();
	const pinned = { startedAt, endedAt: Date.now() };
	return { opened, checkpoints: weighings, logs, errors, pinned };
}

/** How late and how busy the host's loop ran up to `weight`, as a line says it. */
function loopOf(weight: Weight): string {
	return `loop p99 ${Math.round(weight.loopP99Ms)} ms, max ${Math.round(weight.loopMaxMs)} ms, busy ${Math.round(weight.loopBusy * PERCENT)}%`;
}

/** What a burst of window wakes came to, as a line says it. */
function burstOf(wakes: readonly WindowWake[], after: Weight): string {
	const slowest = Math.max(...wakes.map((one) => one.answeredMs));
	return `burst of ${wakes.length}: slowest answered ${slowest} ms, loop max ${Math.round(after.loopMaxMs)} ms`;
}

/** A fresh trusted folder holding the notes a read turn reads. */
function workingFolder(work: Folders): string {
	const cwd = work.trusted();
	writeFileSync(join(cwd, "notes.txt"), "soak notes\n");
	return cwd;
}

/** How a parked conversation wakes at a checkpoint, each way in turn. */
function wakeOf(
	one: Conversation,
	checkpoint: number,
): "window" | "mesh" | "key" {
	const ways = ["window", "mesh", "key"] as const;
	return ways[(one.index + checkpoint) % ways.length] ?? "key";
}

/** Open a window on a parked conversation, timing its wake and first drawing. */
async function windowWake(
	host: ScreenHost,
	one: Conversation,
): Promise<WindowWake> {
	const recordBytes = sizeOf(one.file);
	const started = Date.now();
	const window = await attach(host.path, one.sessionId, ROWS, COLUMNS);
	const answered = Date.now();
	await tried(
		window.sent(/\S/, DRAWN_MS),
		`a window woke ${one.sessionId} and drew nothing`,
	);
	const drawn = Date.now();
	await tried(
		host.idle(one.sessionId, TURN_MS),
		`${one.sessionId} didn't wake by a window`,
	);
	await window.leave();
	return {
		conversation: one.index,
		recordBytes,
		answeredMs: answered - started,
		drawnMs: drawn - answered,
	};
}

/**
 * Wake a parked conversation by the mesh, or leave it for its next key,
 * by which checkpoint this is; one a window wakes woke already. A mesh
 * wake goes untimed: the host lists a waking conversation idle before it
 * has loaded, so nothing outside it says when the wake ends.
 */
async function wake(
	host: ScreenHost,
	one: Conversation,
	checkpoint: number,
	parkFolder: string,
	byKey: Set<string>,
): Promise<void> {
	const how = wakeOf(one, checkpoint);
	if (how === "key") byKey.add(one.sessionId);
	if (how !== "mesh") return;
	if (!askWake(one.sessionId, `soak-${checkpoint}`, parkFolder))
		fault(`${one.sessionId} had no marker to wake it by`);
	await tried(
		host.idle(one.sessionId, TURN_MS),
		`${one.sessionId} didn't wake by the mesh`,
	);
}

/** Take one conversation through its turns, visit by visit, stopping at each checkpoint. */
async function drive(
	host: ScreenHost,
	one: Conversation,
	barrier: (done: number) => Promise<void>,
	byKey: Set<string>,
): Promise<void> {
	await waited(staggerOf(one.index, staggerMs));
	const marks = checkpointsOf(one.turns.length, checkpoints);
	let done = 0;
	let stopped = 0;
	// How it woke at the checkpoint just passed, until its next key.
	let woke: string | undefined;
	const stopsDue = async (viewer?: Viewer) => {
		if (marks[0] !== done) return viewer;
		await viewer?.leave();
		while (marks[0] === done) {
			marks.shift();
			await barrier(done);
			woke = wokeAt(one, stopped);
			stopped += 1;
		}
		return undefined;
	};
	for (const visit of visitsOf(one.turns)) {
		let viewer: Viewer | undefined;
		for (const [at, turn] of visit.turns.entries()) {
			viewer = await stopsDue(viewer);
			viewer ??= await opened(host, one, byKey);
			await typed(host, one, viewer, turn, woke);
			woke = undefined;
			done += 1;
			if (at === 0 && visit.joined) {
				const second = await attach(host.path, one.sessionId, ROWS, COLUMNS);
				await tried(
					second.sent(/\S/, DRAWN_MS),
					`a second viewer of ${one.sessionId} drew nothing`,
				);
				await second.leave();
			}
		}
		await viewer?.leave();
	}
	await stopsDue();
}

/**
 * How `one` woke at its `checkpoint`th stop, when it parked there: its
 * next key can wait on that wake, a mesh's going on as it is typed.
 */
function wokeAt(one: Conversation, checkpoint: number): string | undefined {
	if (values["no-park"]) return undefined;
	return values.burst ? "burst" : wakeOf(one, checkpoint);
}

/** A viewer attached to `one`, drawn unless its first key is to wake it. */
async function opened(
	host: ScreenHost,
	one: Conversation,
	byKey: Set<string>,
): Promise<Viewer> {
	const viewer = await attach(host.path, one.sessionId, ROWS, COLUMNS);
	if (byKey.delete(one.sessionId)) return viewer;
	await tried(
		viewer.sent(/\S/, DRAWN_MS),
		`a viewer of ${one.sessionId} drew nothing`,
	);
	return viewer;
}

/**
 * Type one turn and wait until its answer is in the log and the host
 * lists it idle, noting when its key went, when its prompt was first
 * drawn and when its answer was, and how its conversation woke, when
 * this is its first key since.
 */
async function typed(
	host: ScreenHost,
	one: Conversation,
	viewer: Viewer,
	turn: Turn,
	woke: string | undefined,
): Promise<void> {
	const ack = acknowledged(turn.tag);
	const shown = firstShown(viewer, turn.tag, DRAWN_MS);
	const keyAt = Date.now();
	// The write that first draws the answer settles it; a turn whose
	// answer is never seen drawn settles empty and is counted.
	const drawn = viewer.shows(ack, turnMs).then(
		() => Date.now(),
		() => undefined,
	);
	viewer.type(`${turn.prompt}${ENTER}`);
	const until = Date.now() + turnMs;
	while (!tailOf(one.file).includes(ack)) {
		if (Date.now() > until) {
			const said = host.errors().slice(-SAID_CHARACTERS);
			fault(`${turn.tag} wasn't answered in ${turnMs} ms: ${said}`);
			return;
		}
		// The log says a turn ended only when read, so this waits between reads.
		await new Promise((done) => setTimeout(done, LOOK_EVERY_MS));
	}
	await tried(
		host.idle(one.sessionId, TURN_MS),
		`${turn.tag} answered but never went idle, its log ending ${lastOf(one.file)}`,
	);
	const late = () =>
		new Promise<undefined>((gone) =>
			setTimeout(() => gone(undefined), DRAWN_AFTER_IDLE_MS),
		);
	const drawnAt = await Promise.race([drawn, late()]);
	const shownAt = await Promise.race([shown, late()]);
	typedAt.set(turn.tag, {
		keyAt,
		...(shownAt === undefined ? {} : { shownAt }),
		...(drawnAt === undefined ? {} : { drawnAt }),
		...(woke === undefined ? {} : { woke }),
	});
}

/**
 * When `viewer`'s output from now on first shows `tag`, looked for every
 * few ms, or nothing once `ms` pass: the first drawing a key typed into
 * it brings, which is what a person waits on as they type. The writes
 * are read joined with their escapes stripped, so a tag split across
 * frames still counts. The time is the look's, not the write's arrival,
 * so it reads high by up to SHOWN_LOOK_MS plus this process's own loop
 * lag, which errs towards failing the bar.
 */
function firstShown(
	viewer: Viewer,
	tag: string,
	ms: number,
): Promise<number | undefined> {
	const from = viewer.output.length;
	let looked = from;
	const until = Date.now() + ms;
	return new Promise((done) => {
		const look = () => {
			const { output } = viewer;
			if (output.length > looked) {
				looked = output.length;
				if (showsTag(output.slice(from), tag)) {
					done(Date.now());
					return;
				}
			}
			if (Date.now() > until) done(undefined);
			else setTimeout(look, SHOWN_LOOK_MS);
		};
		look();
	});
}

/** `env` with node told to write a CPU profile into `folder`, under --profile. */
function profiled(env: NodeJS.ProcessEnv, folder: string): NodeJS.ProcessEnv {
	if (!values.profile) return env;
	mkdirSync(folder, { recursive: true });
	const options = `--cpu-prof --cpu-prof-dir=${folder}`;
	const before = env.NODE_OPTIONS;
	return {
		...env,
		NODE_OPTIONS: before ? `${before} ${options}` : options,
	};
}

/** Every CPU profile node wrote into `folder`, parsed. */
function profilesIn(folder: string): unknown[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// A side that wrote no profile has no folder; it reports none.
		return [];
	}
	return names
		.filter((name) => name.endsWith(".cpuprofile"))
		.map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")));
}

/** The kinds of a log's last entries, to say where a conversation stopped. */
function lastOf(file: string): string {
	const kinds = entriesOf(readOr(file))
		.slice(-LAST_ENTRIES)
		.map((entry) => {
			const message = isRecord(entry.message) ? entry.message : {};
			const words = textOf(message).slice(0, LAST_WORDS);
			return [entry.type, entry.customType, message.role, words]
				.filter((part) => typeof part === "string" && part !== "")
				.join(" ");
		});
	return kinds.join(" | ");
}

/** The plain side: one plain pi a conversation, all at once. */
async function runPlain(sealed: Seal): Promise<{
	readonly logs: readonly Record<string, unknown>[][];
	readonly errors: readonly string[];
}> {
	const agentDir = join(sealed.home, ".pi", "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: agent.providers }),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(agent.settings),
	);
	for (const extension of [...FIXTURE_LOADS, ...also]) {
		const entry = join(HARNESS, "extensions", extension, "index.ts");
		writeFileSync(
			join(agentDir, "extensions", `${extension}.ts`),
			`export { default } from ${JSON.stringify(entry)};\n`,
		);
	}
	const work = folders(sealed);
	const env = Object.fromEntries(
		Object.entries(
			profiled({ ...sealed.env, PI_OFFLINE: "1" }, profiles.plain),
		).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
	);
	const cwds = counts.map(() => workingFolder(work));
	const ran = await Promise.all(
		counts.map(async (count, index) => {
			const log = join(out, `plain-${index}.rpc.log`);
			const client = rpcClient(
				{
					command: process.execPath,
					args: [join(packageDir ?? "", "dist/bundle/cli.js"), "--mode", "rpc"],
				},
				cwds[index] ?? "",
				env,
				log,
			);
			await waited(staggerOf(index, staggerMs));
			for (const turn of turnsOf(index, count)) {
				// A job's report starts a turn of its own once the job ends, so
				// the next prompt waits for that turn too, as the hosted side
				// waits for the host to list the conversation idle.
				const reported =
					turn.kind === "job"
						? client.wait(reportSettled(), turnMs)
						: undefined;
				// Awaited below; a failure before then is its to report.
				reported?.catch(() => undefined);
				await tried(client.prompt(turn.prompt, turnMs), `plain ${turn.tag}`);
				if (reported)
					await tried(reported, `plain ${turn.tag}'s job report never settled`);
			}
			const { data } = await client.request({ type: "get_state" });
			const file = isRecord(data) ? data.sessionFile : undefined;
			await client.close();
			const entries =
				typeof file === "string" ? entriesOf(readFileSync(file, "utf8")) : [];
			const spread = spreadOf(latencies(entries).map((one) => one.ms));
			say(`plain ${index} done ${JSON.stringify(spread)}`);
			return { entries, errors: readOr(`${log}.stderr`) };
		}),
	);
	return {
		logs: ran.map((one) => one.entries),
		errors: ran.map((one) => one.errors),
	};
}

/**
 * A match for the first settling after a job's report is heard: the
 * report is a message neither the model's nor a tool's, holding what
 * the job printed.
 */
function reportSettled(): (event: RpcEvent) => boolean {
	let heard = false;
	return (event) => {
		const message = isRecord(event.message) ? event.message : undefined;
		if (
			event.type === "message_end" &&
			message !== undefined &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			JSON.stringify(message).includes(JOB_SAYS)
		)
			heard = true;
		return heard && event.type === "agent_settled";
	};
}

/**
 * A barrier for `parties`: each calls it with how many turns it has done,
 * and all wait until the last arrives, which runs `then` first.
 */
function barrierOf(
	parties: number,
	then: (done: number) => Promise<void>,
): (done: number) => Promise<void> {
	let arrived = 0;
	let most = 0;
	let release: () => void = () => {};
	let gate = new Promise<void>((open) => {
		release = open;
	});
	return async (done) => {
		arrived += 1;
		most = Math.max(most, done);
		const waiting = gate;
		if (arrived < parties) return waiting;
		arrived = 0;
		const opening = release;
		gate = new Promise<void>((open) => {
			release = open;
		});
		await tried(then(most), "checkpoint");
		most = 0;
		opening();
		return waiting;
	};
}

/**
 * The host's weight once it holds none of `ids`' sessions. Parked is
 * said before the host has closed a conversation's runtime and let its
 * session go, and a parked conversation stays listed, so this weighs
 * again until the weighing names none of them. One still held at the
 * end is a fault, and the last weighing stands.
 */
async function weighedOnceLetGo(
	host: ScreenHost,
	ids: readonly string[],
	done: number,
): Promise<Weight> {
	const until = Date.now() + PARK_MS;
	for (;;) {
		const weighed = await host.weigh();
		const held = ids.filter((id) => weighed.sessions.includes(id));
		if (held.length === 0) return weighed;
		if (Date.now() > until) {
			fault(`${held.join(", ")} parked but still held at ${done} turns`);
			return weighed;
		}
		await new Promise((later) => setTimeout(later, REWEIGH_EVERY_MS));
	}
}

/** Wait for `work`, counting its failure as a fault saying `what`. */
async function tried(work: Promise<unknown>, what: string): Promise<void> {
	await work.catch((error: unknown) => fault(`${what}: ${String(error)}`));
}

/** The end of a log, or nothing while it isn't written yet. */
function tailOf(file: string): string {
	let handle: number;
	try {
		handle = openSync(file, "r");
	} catch {
		// pi writes a conversation's log once its first answer comes.
		return "";
	}
	try {
		const size = statSync(file).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(handle, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		closeSync(handle);
	}
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		// A conversation that has had no answer yet has no log.
		return 0;
	}
}

function readOr(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// A pi that wrote nothing to stderr left no file.
		return "";
	}
}

/** The lines of what a process wrote that say something went wrong. */
function errorsIn(written: string): string[] {
	return written.split("\n").filter((line) => /error|fail|warn/i.test(line));
}

/** A promise settled once `ms` have passed. */
function waited(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function sum(values: readonly number[]): number {
	return values.reduce((all, value) => all + value, 0);
}
