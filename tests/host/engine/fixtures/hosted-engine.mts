// One step of a host's life on the engine, run by node as the host runs: it prints what the conversation and its extensions saw.
/**
 * Run as `node hosted-engine.mts <package dir> <folder> <scenario>`, with
 * HOME inside the folder, so pi's agent folder, its settings, models and
 * extensions are the folder's. The folder outlives a run, so a later run
 * plays the host's next start: entry.json is the roster entry a run held,
 * effects counts what a tool really did, and probe.jsonl is what the
 * probe extension saw. It prints one JSON line. Long because each
 * scenario is one step of a host's life, and the steps share the host,
 * the screens and the helpers they run on.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	EngineKey,
	EngineScreens,
	HostEngine,
	HostedView,
} from "../../../../host/engine/contract.ts";
import { SETTLE_MS } from "../../../../host/engine/quiet-collection.ts";
import type { SessionHost } from "../../../../host/engine/session-host.ts";
import { NO_PROC_NOTICE } from "../../../../host/engine/tool-children.ts";
import { piFromHost } from "../../../../host/service/pi-resolution.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";
import { watchSpawns } from "../../../support/spawns.ts";
import { quietFor, until } from "../../../support/until.ts";

/** What the fixture uses of pi-ai's scripted provider. */
interface Compat {
	registerFauxProvider(options: object): {
		readonly api: string;
		setResponses(responses: readonly unknown[]): void;
	};
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options: { id: string }): unknown;
}

/** A pi module as the fixture uses it: pi's JavaScript carries no types here, so the shape is declared above. */
function piModule<T>(module: unknown): T {
	return module as T;
}

/** The command line's argument at position, refusing the run without it. */
function argument(position: number): string {
	const value = process.argv[position + 2];
	if (!value)
		throw new Error(
			"usage: hosted-engine.mts <package dir> <folder> <scenario>",
		);
	return value;
}

const packageDir = argument(0);
const folder = argument(1);
const scenarioName = argument(2);

// The harness's code binds the host's pi, as pi-host binds it in a host, so
// what loads after pi (kept history) runs on the pi the host was built with,
// not the tree's dev copy. The hook goes in before any harness code loads.
const hostPi = piFromHost(packageDir);
/** Where kept history's rollover module found pi-ai, once it has loaded. */
let rolloverPi: string | undefined;
registerHooks({
	resolve: (specifier, context, next) => {
		// Read before resolving: once the hook has handed the install's root on
		// as the parent, this context's parentURL names that root, not rollover.
		const fromRollover =
			specifier === "@earendil-works/pi-ai" &&
			(context.parentURL?.endsWith("/lib/internal/session/rollover.ts") ??
				false);
		const resolved = hostPi(specifier, context, next);
		if (fromRollover) rolloverPi = resolved.url;
		return resolved;
	},
});
const { createEngine } = await import("../../../../host/engine/engine.ts");
const { bindHeadless } = await import("../../../../host/engine/headless.ts");
const sessionHosts = await import("../../../../host/engine/session-host.ts");
const { emptyOverlay, layBudget } = await import(
	"../../../../lib/budget/environment.ts"
);
const { LONG_CACHE_LIFETIME_MS, warmingDelayMs } = await import(
	"../../../../lib/internal/cache/cache-warming.ts"
);
const {
	pendingWarmsDir,
	takePendingWarms,
	warmingCarryDir,
	writeWarmingCarry,
} = await import("../../../../lib/internal/cache/warming-carry.ts");
const { heldLight } = await import("../../../../host/engine/light-open.ts");
const { holdForCarry } = await import(
	"../../../../lib/internal/carry/under-way.ts"
);
const { holdForMove, letMoveGo } = await import(
	"../../../../lib/internal/session/move-waiting.ts"
);
const { WAKE_ENV, writeParked } = await import(
	"../../../../lib/internal/session/park.ts"
);
const { ROLLOVER_RECORD } = await import(
	"../../../../lib/internal/session/rollover.ts"
);

/**
 * Whether kept history's pi-ai is the one the host's pi installs. It
 * checks this fixture's load order, its hook before its own rollover
 * import, not that the engine loads kept history late: the engine itself
 * loads after the hook here, so that order is held by
 * program-binds-no-pi-at-load.test.ts and pi-host.test.ts instead.
 */
function keptHistoryOnHostPi(): boolean {
	const installed = realpathSync(
		join(packageDir, "node_modules/@earendil-works/pi-ai"),
	);
	return rolloverPi?.startsWith(pathToFileURL(`${installed}/`).href) ?? false;
}

const compat = piModule<Compat>(
	await import(
		pathToFileURL(
			join(packageDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
		).href
	),
);

/** This package's root, which a scenario's pi may load as a package. */
const HARNESS = join(import.meta.dirname, "..", "..", "..", "..");
const PROVIDER = "hosted-faux";
/** Where the probe's `/probe-wait` leaves what ends its wait. */
const WAIT_RELEASE = Symbol.for("test-host.probe-wait.release");
const MODEL = "faux-1";
const work = join(folder, "work");
/** A symlink to the work folder, which conversations are opened through. */
const workLink = join(folder, "work-link");
/** The folder each opened conversation was given, in this run. */
const openedIn: string[] = [];
/** An extension the engine is given as pi's `-e` gives one, and the file it notes each load in. */
const flaggedExtension = join(folder, "flagged.mjs");
const flaggedLoads = join(folder, "flagged.jsonl");
/** What the flagged extension's load awaits, where a scenario sets it, so a build stays under way. */
const BUILD_HOLD = Symbol.for("test-host.build-hold");
/** Which copy of the linked extension each of its loads ran, as its helper module named it. */
const linkedLoads = join(folder, "linked.jsonl");
const agentDir = join(folder, "home", ".pi", "agent");
const entryFile = join(folder, "entry.json");
/** The roster entry of a compacted log one step leaves for the next to resume first. */
const comeBack = join(folder, "come-back.json");
/** The probe's own record, which its load says stays behind (probe-extension.mts). */
const PROBE_RECORD = "probe-record";
const effects = join(folder, "effects");
/** The pids of what the crashing tool left running, one in its group and one that left it. */
const children = join(folder, "children");
const probe = join(folder, "probe.jsonl");
/** The subagent install the probe found each time it loaded. */
const installs = join(folder, "installs.jsonl");
/** Which conversation each probe load and event ran as. */
const runsAs = join(folder, "as.jsonl");
/** What the engine told the service of conversations becoming others and ending, in this run. */
const became: { previousId: string; sessionId: string; held: string }[] = [];
const ended: { sessionId: string; why: string }[] = [];
/** Each key a request carried, as the provider saw it. */
const keysSeen: unknown[] = [];
/** The held run's answer waits on this until the scenario lets it go. */
const heldRun: { started: boolean; release?: () => void } = {
	started: false,
};
/** The header an extension's registration of the provider sets, on each request that carried it. */
const KEPT_HEADER = "x-registered-by";
const registeredHeadersSeen: unknown[] = [];
/**
 * Where it stands, the provider is an extension's registration, as
 * Shopify's proxy registers anthropic, rather than models.json's.
 */
const providerByExtension = existsSync(join(folder, "provider-by-extension"));
/** The request each launch environment was derived for, in this run. */
const derived: string[] = [];
/** The variable the fixture's launch environment sets. */
const OPENED_AS = "OPENED_AS";
/** What the engine reported, in this run. */
const reported: string[] = [];

/**
 * Note what the engine reported, but for the notice a Mac's host gives
 * as it starts, having no /proc: true there, and nothing a case asks.
 */
function noteReported(error: unknown): void {
	const said = String(error);
	if (said !== NO_PROC_NOTICE) reported.push(said);
}
/** Project folders, each with an extension of its own that notes its loads in projectLoads. */
const projects = join(folder, "projects");
const projectLoads = join(folder, "project-loads.jsonl");
/** The label pi's trust question offers for trusting a folder for this session alone. */
const TRUST_THIS_SESSION = "Trust (this session only)";
/** How long a condition the fixture waits on may take. */
const UNTIL_MS = 60_000;

/**
 * How long a build's settling may take to bring a collection: SETTLE_MS,
 * and the collection's own pause, with room for a loaded machine.
 */
const COLLECTED_WITHIN_MS = 30_000;

/** Whether the engine has said a collection once quiet, in this run. */
function collectedQuietly(): boolean {
	return reported.some((said) => said.startsWith("Collected while quiet"));
}

/** Linux's access mode bits in a descriptor's flags, and the one that only reads. */
const ACCESS_MODE = 0o3;
const READ_ONLY = 0o0;

/** A question the fixture's screens were asked about a folder, and what settles it. */
interface TrustAsked {
	readonly sessionId: string;
	readonly cwd: string;
	readonly title: string;
	readonly labels: readonly string[];
	readonly answer: (label: string | undefined) => void;
}
const trustAsked: TrustAsked[] = [];
const screensOpened = new Set<string>();
const screensClosed: string[] = [];
/** Each conversation a screen was told parks, where `closed` would be. */
const screensParked: string[] = [];

/** Screens that bind nothing, note what they are handed, and hold each trust question for the scenario to answer; a close settles it unanswered. */
function trustScreens(): EngineScreens {
	return {
		askProjectTrust: (sessionId, cwd, title, labels) =>
			new Promise((answer) => {
				trustAsked.push({ sessionId, cwd, title, labels, answer });
			}),
		opened: (view) => {
			screensOpened.add(view.sessionId);
		},
		rebound: () => {},
		closed: (sessionId) => {
			screensClosed.push(sessionId);
			for (const asked of trustAsked)
				if (asked.sessionId === sessionId) asked.answer(undefined);
		},
	};
}

/** What answers the select the asking screens' UI is showing, while one is. */
let selectAnswer: ((label: string | undefined) => void) | undefined;
/** What the asking screens were told failed, by conversation. */
const screenFailures: { sessionId: string; message: string }[] = [];

/**
 * Screens that bind a UI whose select waits for the scenario to answer it,
 * telling the engine that the person is being asked, as a hosted screen
 * does when a dialog opens before any viewer attached. Every other call
 * on the UI does nothing.
 */
function askingScreens(): EngineScreens {
	const select = (): Promise<string | undefined> =>
		new Promise((answer) => {
			selectAnswer = answer;
		});
	return {
		opened: async (view, signals) => {
			screensOpened.add(view.sessionId);
			const asking = (): Promise<string | undefined> => {
				const answer = select();
				signals.asking();
				return answer;
			};
			await view.runtime.session.bindExtensions({
				uiContext: new Proxy(
					{},
					{ get: (_ui, key) => (key === "select" ? asking : () => undefined) },
				),
			});
		},
		rebound: () => {},
		failed: (sessionId, message) => {
			screenFailures.push({ sessionId, message });
		},
		closed: () => selectAnswer?.(undefined),
	};
}

/** The host the step runs, for screens that look at it as the engine calls them. */
let runningHost: SessionHost | undefined;
/**
 * Each rebind the rebinding screens were asked for, and whether the host
 * still held the conversation it replaced with its close not yet begun:
 * a close parks a conversation as it starts.
 */
const rebounds: {
	sessionId: string;
	previousId: string;
	previousOpen: boolean;
}[] = [];

/**
 * Screens that bind each session as the engine binds one with no screen,
 * so an extension's command can ask pi for a new session, and note each
 * rebind pi's replacement asks for, binding the new session too. Bound
 * with no command actions, pi's newSession does nothing and says so.
 */
function rebindingScreens(): EngineScreens {
	const bind = (view: HostedView) => {
		if (!runningHost) throw new Error("A screen bound before its host ran");
		return bindHeadless(view.runtime, runningHost, noteReported);
	};
	return {
		opened: (view) => bind(view),
		rebound: async (view, previousId) => {
			const previous = runningHost?.holds(previousId);
			rebounds.push({
				sessionId: view.sessionId,
				previousId,
				previousOpen: previous !== undefined && previous !== "parked",
			});
			await bind(view);
		},
		closed: () => {},
	};
}

/** The engine's durable store for each conversation, under its own folder of the state folder. */
const STORE_FILE = "durable.sqlite";
/** Which conversation's store the step leaves unopenable: the one an open names, or the one a replacement becomes. */
let refusedStore: "opened" | "next" | undefined;

/** Leave a conversation's store unopenable, a folder where its file goes, so its build fails once the host holds it. */
function refuseStore(sessionId: string): void {
	mkdirSync(join(folder, "state", sessionId, STORE_FILE), { recursive: true });
}

/** A project folder holding an extension of its own, which pi loads only where the folder is trusted. */
function project(name: string): string {
	const dir = emptyProject(name);
	projectExtension(dir, "project", name);
	return dir;
}

/** A project folder holding nothing yet, by its real path. */
function emptyProject(name: string): string {
	const dir = join(projects, name);
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

/** Give `dir` an extension named `file` that notes each load in projectLoads as `loaded`. */
function projectExtension(dir: string, file: string, loaded: string): void {
	mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "extensions", `${file}.ts`),
		[
			'import { appendFileSync } from "node:fs";',
			"export default function () {",
			`\tappendFileSync(${JSON.stringify(projectLoads)}, ${JSON.stringify(`${JSON.stringify({ loaded })}\n`)});`,
			"}",
			"",
		].join("\n"),
	);
}

/** Whether a probe line says pi refused its `/probe-switch`. */
function switchCancelled(line: unknown): boolean {
	const event = field(line, "event");
	return event === "switch-cancelled" || event === "switch-refused";
}

/** Whether a probe line is something other than its input handler's answer. */
function notAsked(line: unknown): boolean {
	return field(line, "event") !== "input-asked";
}

/** One field of something read loosely, or nothing when it isn't an object. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, key)
		: undefined;
}

/** A cache carry for the conversation, last read a warming delay ago, so its warm is due as it parks. */
function writeDueCarry(sessionId: string): void {
	const lastRead =
		Date.now() - (warmingDelayMs(LONG_CACHE_LIFETIME_MS) ?? 0) - 1000;
	writeWarmingCarry(warmingCarryDir(), {
		sessionId,
		payload: {
			model: MODEL,
			max_tokens: 64,
			system: [
				{
					type: "text",
					text: "a prompt",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [{ role: "user", content: "hi" }],
		},
		headers: {},
		provider: PROVIDER,
		modelId: MODEL,
		at: lastRead,
		refreshedAt: lastRead,
		warms: 0,
	});
}

/** The marker park-workflow writes as its conversation parks, naming the wake file the engine gave it. */
function writeMarker(host: SessionHost, id: string): void {
	const entry = readEntry();
	const wake = host.env(id).snapshot()[WAKE_ENV];
	if (wake === undefined) throw new Error(`${id} was given no wake file`);
	writeParked({
		session: id,
		sessionFile: entry.file,
		cwd: entry.cwd,
		addresses: [],
		parkedAt: new Date().toISOString(),
		pid: process.pid,
		wake,
	});
}

/** Until a parked warm went out past the `before` requests already seen, and was kept, or failed. */
async function warmed(before: number): Promise<void> {
	const failed = () => reported.some((line) => line.includes("Parked warm"));
	await until(
		"its warm to go out or fail",
		() => keysSeen.length > before || failed(),
		UNTIL_MS,
	);
	// A host keeps the warm off its thread, making the folder and then the
	// file before it appends the warm, so only a whole line says it is in.
	await until(
		"its warm to be kept or fail",
		() => keptWarms() || failed(),
		UNTIL_MS,
	);
}

/** Whether any warm is kept for a parked conversation's next start. */
function keptWarms(): boolean {
	const dir = pendingWarmsDir();
	return (
		existsSync(dir) &&
		readdirSync(dir).some(
			(name) =>
				name.endsWith(".jsonl") &&
				readFileSync(join(dir, name), "utf8").endsWith("\n"),
		)
	);
}

const say =
	(text: string) =>
	(
		_context: unknown,
		options: { apiKey?: unknown; headers?: Record<string, unknown> },
	) => {
		keysSeen.push(options.apiKey);
		const registered = options.headers?.[KEPT_HEADER];
		if (registered !== undefined) registeredHeadersSeen.push(registered);
		return compat.fauxAssistantMessage(text);
	};

interface Scenario {
	responses: () => unknown[];
	/** The API the scripted provider answers as, when it must stand in for a real one. */
	api?: string;
	/** Whether pi loads this package, as Joel's settings have it, beside the probe. */
	harness?: true;
	/** The screens the engine hands conversations to; none binds them with no interface. */
	screens?: () => EngineScreens;
	/** What each conversation's launch names for itself, beside what the engine derives. */
	launch?: Readonly<Record<string, string>>;
	/** The variable the scripted provider's key is read from; the gateway key's unless named. */
	keyVariable?: string;
	/** What the host's own process holds beyond the sealed environment it runs in. */
	hostEnv?: Readonly<Record<string, string>>;
	/** The engine runs one conversation, as a child's does, its notes kept apart. */
	oneConversation?: true;
	run: (
		engine: HostEngine,
		host: SessionHost,
	) => Promise<Record<string, unknown>>;
}

const keys = ["first-key", "second-key"];
let keyIndex = 0;
const key: EngineKey = {
	inherited: false,
	current: async () => keys[Math.min(keyIndex, keys.length - 1)] ?? "",
	refused: () => {
		keyIndex++;
	},
};

/** Open with first words, answer them, then close, for what the provider was sent. */
async function answerOnce(
	engine: HostEngine,
	host: SessionHost,
): Promise<Record<string, unknown>> {
	const id = await open(engine, { first: "hi" });
	await idle(engine, id);
	await host.close(id);
	return {};
}

const scenarios: Record<string, Scenario> = {
	/** Open with first words, answer them, then close. */
	open: {
		responses: () => [say("hello there")],
		run: async (engine, host) => {
			const id = await open(engine, { first: "hi" });
			await idle(engine, id);
			const seen = {
				...summary(engine, id),
				env: envOf(host, id),
				state: host.holds(id),
			};
			await host.close(id);
			return { ...seen, after: host.holds(id) ?? "gone" };
		},
	},
	/** Park a conversation whose cache is due a warm, which goes once the host has let it go. */
	"warm-parked": {
		// Only Anthropic's messages API is warmed, so the scripted provider answers as it.
		api: "anthropic-messages",
		responses: () => [say("hello there"), say("")],
		run: async (engine, host) => {
			const id = await open(engine, { first: "hi" });
			await idle(engine, id);
			writeDueCarry(id);
			host.park(id);
			await warmed(1);
			return { pending: takePendingWarms(pendingWarmsDir(), id).length };
		},
	},
	/** Park a conversation and stop, as a host does before it restarts; warm-resting plays its next start. */
	"park-to-restart": {
		api: "anthropic-messages",
		responses: () => [say("hello there")],
		run: async (engine, host) => {
			const id = await open(engine, { first: "hi" });
			await idle(engine, id);
			writeMarker(host, id);
			host.park(id);
			// The park starts a turn after it is asked for.
			await new Promise((later) => setImmediate(later));
			await engine.parkSettled?.(id);
			return { held: host.holds(id) ?? "let go" };
		},
	},
	/**
	 * Park a conversation whose host can't say it parks, so its stop throws
	 * before it begins, then close it: it runs on, its bus told why, and
	 * its close is a close, not a park.
	 */
	"park-refused": {
		responses: () => [say("hello there")],
		screens: () => ({
			opened: () => {},
			rebound: () => {},
			closed: (sessionId) => {
				screensClosed.push(sessionId);
			},
			parked: (sessionId) => {
				screensParked.push(sessionId);
			},
		}),
		run: async (engine, host) => {
			const id = await open(engine, { first: "hi" });
			await idle(engine, id);
			// A folder where the host's registry goes, so saying it parks throws.
			const saved = `${host.registryPath}.saved`;
			renameSync(host.registryPath, saved);
			mkdirSync(host.registryPath);
			try {
				await parkNow(engine, host, id);
			} finally {
				rmSync(host.registryPath, { recursive: true });
				renameSync(saved, host.registryPath);
			}
			const runsOn = host.holds(id) ?? "let go";
			await host.close(id);
			return {
				sessionId: id,
				runsOn,
				screensClosed: [...screensClosed],
				screensParked: [...screensParked],
			};
		},
	},
	/** Start again on a conversation parked before, which rests parked and is still kept warm. */
	"warm-resting": {
		api: "anthropic-messages",
		responses: () => [say("")],
		run: async (engine) => {
			const entry = readEntry();
			writeDueCarry(entry.sessionId);
			const rests = engine.restsParked?.(entry) ?? false;
			await warmed(0);
			return {
				rests,
				pending: takePendingWarms(pendingWarmsDir(), entry.sessionId).length,
			};
		},
	},
	/**
	 * The log the host holds open of each conversation as it opens, becomes
	 * another, parks, wakes and closes, and of one closed while parked.
	 */
	"logs-held": {
		responses: () => [say("hello there")],
		run: async (engine, host) => {
			const first = await open(engine, { first: "hi" });
			await idle(engine, first);
			const firstFile = readEntry().file;
			const opened = logHolds(firstFile);
			await host.run(first, () => prompt(engine, first, "/probe-new"));
			const next = readEntry();
			await until(
				"the first conversation to end",
				() => !host.holds(first),
				UNTIL_MS,
			);
			const afterNew = {
				first: logHolds(firstFile),
				next: logHolds(next.file),
			};
			await parkNow(engine, host, next.sessionId);
			const whileParked = logHolds(next.file);
			await engine.resume(next, true);
			const woken = logHolds(next.file);
			await host.close(next.sessionId);
			const closed = logHolds(next.file);
			const other = await open(engine, {});
			const otherFile = readEntry().file;
			await parkNow(engine, host, other);
			await engine.dropped?.(other, "closed while parked");
			return {
				logs: {
					opened,
					afterNew,
					whileParked,
					woken,
					closed,
					closedParked: logHolds(otherFile),
				},
			};
		},
	},
	/**
	 * What the host holds of a compacted log on each way it builds one
	 * from disk: a resume and an adopt, through the engine's own binding,
	 * and a conversation an extension's command switches to, through the
	 * parts a replacement is built from.
	 */
	"kept-history": {
		// Each conversation is compacted in full before the next starts, so
		// its three turns are answered in a row.
		responses: () =>
			["first", "second", "third"].flatMap((conversation) =>
				["early", "kept", "after"].map((word) =>
					say(`${conversation} ${word}`),
				),
			),
		run: async (engine, host) => {
			const first = await compacted(engine, host);
			const second = await compacted(engine, host);
			const third = await compacted(engine, host);
			const request = {
				v: 1 as const,
				id: "adopt-1",
				op: "adopt" as const,
				sessionFile: third.entry.file,
				attended: false,
			};
			const prepared = await engine.prepare(request);
			await engine.start(prepared, request);
			await idle(engine, prepared.sessionId);
			const adopted = heldOf(engine, prepared.sessionId, third);
			await host.close(prepared.sessionId);
			await engine.resume(first.entry);
			await idle(engine, first.entry.sessionId);
			const resumed = heldOf(engine, first.entry.sessionId, first);
			// Closed once compacted, so only the switch can hold it again.
			const closedBefore = engine.view(second.entry.sessionId) === undefined;
			await host.run(first.entry.sessionId, () =>
				prompt(
					engine,
					first.entry.sessionId,
					`/probe-switch ${second.entry.file}`,
				),
			);
			const switched = second.entry.sessionId;
			await until(
				"the conversation switched to to be held",
				() => {
					const refused = lines(probe).find(switchCancelled);
					if (refused)
						throw new Error(
							`pi refused the switch to ${second.entry.file}: ${JSON.stringify(refused)}`,
						);
					return engine.view(switched) !== undefined;
				},
				UNTIL_MS,
			);
			const replaced = heldOf(engine, switched, second);
			const switchedTo = summary(engine, switched).file === second.entry.file;
			await host.close(switched);
			return {
				keptHistory: {
					resumed,
					adopted,
					replaced,
					closedBefore,
					switchedTo,
					onHostPi: keptHistoryOnHostPi(),
					// What the engine said of its light opens: that one fell back,
					// or that the pi it was given isn't what they read.
					lightOpens: reported.filter((said) =>
						/light open|Light opens/.test(said),
					),
				},
			};
		},
	},
	/** Leave a compacted log holding the probe's record, for a fresh host to resume first. */
	"compacted-to-come-back": {
		responses: () => ["early", "kept", "after"].map((word) => say(word)),
		run: async (engine, host) => {
			const { entry } = await compacted(engine, host, PROBE_RECORD);
			writeFileSync(comeBack, JSON.stringify(entry));
			return {};
		},
	},
	/**
	 * Resume that log as a fresh host's first act, so it is held before any
	 * load in the process says the probe's record stays behind: whether the
	 * view holds that record once the conversation is built, and its own.
	 */
	"resumed-first": {
		responses: () => [],
		run: async (engine, host) => {
			const entry: RosterEntry = JSON.parse(readFileSync(comeBack, "utf8"));
			await engine.resume(entry);
			await idle(engine, entry.sessionId);
			const types = (logOf(engine, entry.sessionId)?.fileEntries ?? []).map(
				(each) => each.customType,
			);
			await host.close(entry.sessionId);
			return {
				resumedFirst: {
					record: types.includes(ROLLOVER_RECORD),
					probeRecord: types.includes(PROBE_RECORD),
				},
			};
		},
	},
	/** Start again on a conversation parked before, which rests parked, its log held. */
	"log-resting": {
		responses: () => [],
		run: async (engine) => {
			const entry = readEntry();
			const rests = engine.restsParked?.(entry) ?? false;
			return { rests, logs: { resting: logHolds(entry.file) } };
		},
	},
	/** Rest one parked before, then give it up to a child that runs it now. */
	"moved-out": {
		responses: () => [],
		run: async (engine) => {
			const entry = readEntry();
			const rests = engine.restsParked?.(entry) ?? false;
			const resting = logHolds(entry.file);
			engine.movedOut?.(entry.sessionId);
			return { rests, logs: { resting, movedOut: logHolds(entry.file) } };
		},
	},
	/** The gateway refuses the first key; the request goes again on the next. */
	renew: {
		responses: () => [
			(_context: unknown, options: { apiKey?: unknown }) => {
				keysSeen.push(options.apiKey);
				throw new Error("401 Unauthorized: the key has expired");
			},
			say("hello again"),
		],
		run: async (engine, host) => {
			const id = await open(engine, { first: "hi" });
			await idle(engine, id);
			const seen = summary(engine, id);
			await host.close(id);
			return seen;
		},
	},
	/** Open on a command that waits as one asking a person does, then end its wait. */
	"open-waiting": {
		responses: () => [],
		run: async (engine, host) => {
			const id = await open(engine, { first: "/probe-wait" });
			// The open has answered; the command is still waiting if its release is there to call.
			const release: unknown = Reflect.get(globalThis, WAIT_RELEASE);
			const answeredWhileWaiting = typeof release === "function";
			if (typeof release === "function") release();
			await idle(engine, id);
			await host.close(id);
			return { answeredWhileWaiting };
		},
	},
	/** Open with first words an extension's input handler asks the person about, at a screen nobody has attached to yet. */
	"open-asking": {
		responses: () => [say("went on")],
		screens: askingScreens,
		run: async (engine, host) => {
			const id = await open(
				engine,
				{ first: "ask me first" },
				{ attended: true },
			);
			const answeredWhileAsking =
				selectAnswer !== undefined && lines(probe).every(notAsked);
			selectAnswer?.("Yes");
			await until(
				"the first words to be answered",
				() => String(summary(engine, id).transcript).includes("went on"),
				UNTIL_MS,
			);
			await idle(engine, id);
			const seen = { ...summary(engine, id), answeredWhileAsking };
			await host.close(id);
			// A second whose model is gone by the time the person answers, so its first words fail after its start answered.
			const lost = await open(
				engine,
				{ first: "ask me first" },
				{ attended: true },
			);
			const state = field(
				field(engine.view(lost)?.runtime.session, "agent"),
				"state",
			);
			if (typeof state !== "object" || state === null)
				throw new Error("The lost conversation has no agent state");
			Reflect.set(state, "model", undefined);
			selectAnswer?.("Yes");
			await until(
				"the lost conversation's screen to be told",
				() => screenFailures.some(({ sessionId }) => sessionId === lost),
				UNTIL_MS,
			);
			await host.close(lost);
			return {
				...seen,
				screenFailures: screenFailures.map(({ sessionId, message }) => ({
					lost: sessionId === lost,
					message,
				})),
			};
		},
	},
	/** Open with no words, then stop the host, as a restart does. */
	"open-quiet": {
		responses: () => [],
		run: async (engine, host) => {
			const id = await open(engine, {});
			await host.stop(id);
			return { file: existsSync(readEntry().file) };
		},
	},
	/** Open and answer a conversation in a tree's folder, then stop, as a host does to restart. */
	"open-in-tree": {
		responses: () => [say("hello there")],
		run: async (engine, host) => {
			const tree = join(work, "tree", "deep");
			mkdirSync(tree, { recursive: true });
			const id = await open(engine, { first: "hi" }, { cwd: tree });
			await idle(engine, id);
			await host.stop(id);
			return { sessionId: id };
		},
	},
	/** A tool that notes it ran, leaves two commands running, and then kills the host. */
	crash: {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall(
						"bash",
						{
							command: [
								`echo ran >> ${effects}`,
								`sleep 300 & echo $! > ${children}`,
								`setsid sleep 301 & echo $! >> ${children}`,
								`kill -9 ${process.pid}`,
							].join("\n"),
						},
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
		],
		run: async (engine) => {
			const id = await open(engine, { first: "run it" });
			await idle(engine, id);
			return { survived: true };
		},
	},
	/**
	 * A command that ends by itself, leaving one process running under a
	 * call's mark as shell-workflow gives it and one under none, then the
	 * conversation parks.
	 */
	"leave-and-park": {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall(
						"bash",
						{
							command: [
								`PI_BASH_CALL=ended-call sleep 300 >/dev/null 2>&1 & echo $! > ${children}`,
								`sleep 301 >/dev/null 2>&1 & echo $! >> ${children}`,
							].join("\n"),
						},
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			say("left them"),
		],
		run: async (engine, host) => {
			const id = await open(engine, { first: "leave them" });
			await idle(engine, id);
			await parkNow(engine, host, id);
			return { held: host.holds(id) ?? "let go" };
		},
	},
	/**
	 * The same command, then the host stops the conversation for its
	 * restart while it was never parked, as a drain finds one busy.
	 */
	"leave-and-stop": {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall(
						"bash",
						{
							command: [
								`PI_BASH_CALL=ended-call sleep 300 >/dev/null 2>&1 & echo $! > ${children}`,
								`sleep 301 >/dev/null 2>&1 & echo $! >> ${children}`,
							].join("\n"),
						},
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			say("left them"),
		],
		run: async (engine, host) => {
			const id = await open(engine, { first: "leave them" });
			await idle(engine, id);
			await host.stop(id, "host restarting", true);
			return { held: host.holds(id) ?? "let go" };
		},
	},
	/** Leave commands running, then close the conversation the service releases while it runs, as it hands one on to plain pi. */
	"leave-and-release": {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall(
						"bash",
						{
							command: [
								`PI_BASH_CALL=ended-call sleep 300 >/dev/null 2>&1 & echo $! > ${children}`,
								`sleep 301 >/dev/null 2>&1 & echo $! >> ${children}`,
							].join("\n"),
						},
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			say("left them"),
		],
		run: async (engine, host) => {
			const id = await open(engine, { first: "leave them" });
			await idle(engine, id);
			engine.handsOn?.(id);
			await host.close(id, "released, asked by a test");
			return { held: host.holds(id) ?? "let go" };
		},
	},
	/** The next host closes for good the conversation the last one parked, as the service closes one held but not running. */
	"close-parked": {
		responses: () => [],
		run: async (engine) => {
			await engine.dropped?.(readEntry().sessionId, "closed, asked by a test");
			return {};
		},
	},
	/** The next host releases the conversation the last one parked, as the service hands one on to plain pi. */
	"release-parked": {
		responses: () => [],
		run: async (engine) => {
			const { sessionId } = readEntry();
			engine.handsOn?.(sessionId);
			await engine.dropped?.(sessionId, "released, asked by a test");
			return {};
		},
	},
	/** The next host resumes the conversation the last one parked, then closes it for good. */
	"resume-and-close": {
		responses: () => [],
		run: async (engine, host) => {
			const entry = readEntry();
			await engine.resume(entry);
			await idle(engine, entry.sessionId);
			// What the resume's reap left, before the close.
			const resumed = leftRunning().filter(alive);
			await host.close(entry.sessionId, "closed, asked by a test");
			return { resumed };
		},
	},
	/**
	 * Open on the harness and have the probe note every tool the
	 * conversation has, for the test to hold against a plain pi's.
	 */
	tools: {
		responses: () => [],
		harness: true,
		run: async (engine, host) => {
			const id = await open(engine, { first: "/tools-probe" });
			await idle(engine, id);
			// What the conversation's screen is handed to show as it starts.
			const diagnostics = engine.view(id)?.runtime.diagnostics;
			await host.close(id);
			return { diagnostics };
		},
	},
	/**
	 * A turn on the harness, as Joel's conversations run it: a bash call
	 * and an answer, watched from the prompt until the conversation is idle
	 * for every child process started meanwhile, by the turn, its tool or
	 * any timer, and how.
	 */
	"turn-children": {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall(
						"bash",
						{ command: `echo ran >> ${effects}` },
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			say("done"),
		],
		harness: true,
		run: async (engine, host) => {
			const id = await open(engine, {});
			await idle(engine, id);
			const watch = watchSpawns();
			try {
				await host.run(id, () => prompt(engine, id, "run it"));
				await idle(engine, id);
			} finally {
				watch.stop();
			}
			const seen = {
				...summary(engine, id),
				blocking: watch.blocking(),
				started: watch.started.map(({ how, program }) => `${how} ${program}`),
			};
			await host.close(id);
			return seen;
		},
	},
	/** Count the background work a conversation holds, before and after its extension hands some off. */
	background: {
		responses: () => [],
		harness: true,
		run: async (engine, host) => {
			const id = await open(engine, {});
			await idle(engine, id);
			const before = engine.background();
			await host.run(id, () => prompt(engine, id, "/probe-job"));
			await idle(engine, id);
			const during = engine.background();
			const own = engine.backgroundOf(id);
			const unheld = engine.backgroundOf("never-held");
			await host.close(id);
			return { background: { before, during, own, unheld } };
		},
	},
	/** Hold a conversation for a carry: what a restart waits on, and a reload refused, then both once it lets go. */
	"carry-held": {
		responses: () => [],
		run: async (engine, host) => {
			const id = await open(engine, {});
			await idle(engine, id);
			const reloaded = () =>
				host.reload(id, { reason: "the install moved" }).then(
					() => "reloaded",
					(error: unknown) =>
						error instanceof Error ? error.message : String(error),
				);
			const before = engine.background();
			const hold = holdForCarry(id, "penelope");
			let during: number;
			let holding: readonly string[];
			let reloadDuring: string;
			try {
				during = engine.background();
				holding = engine.holding();
				reloadDuring = await reloaded();
			} finally {
				hold.release();
			}
			const after = engine.background();
			const reloadAfter = await reloaded();
			await host.close(id);
			return {
				firstId: id,
				carryHeld: {
					before,
					during,
					after,
					holding,
					reloadDuring,
					reloadAfter,
				},
			};
		},
	},
	/**
	 * Hold a conversation for a move taken during its run, after the
	 * follower's reload was asked: refused once idle, another's let go,
	 * then the follower's once the move lets go.
	 */
	"move-held": {
		responses: () => [
			async () => {
				heldRun.started = true;
				await new Promise<void>((resolve) => {
					heldRun.release = resolve;
				});
				return compat.fauxAssistantMessage("let go");
			},
		],
		run: async (engine, host) => {
			const id = await open(engine, {});
			await idle(engine, id);
			const reloaded = (yieldsToMove: boolean) =>
				host
					.reload(id, {
						reason: "the install moved",
						...(yieldsToMove ? { yieldsToMove } : {}),
					})
					.then(
						() => "reloaded",
						(error: unknown) =>
							error instanceof Error ? error.message : String(error),
					);
			// Asked while the run is under way and held before it ends, so
			// only a look after the engine's wait for idle can refuse it.
			// The reload's body starts a microtask after it is asked, so a
			// hold taken at once would already stand for a look before the
			// wait: one turn of the loop lets the reload reach that wait,
			// which the held run keeps it in.
			const answering = prompt(engine, id, "hold on");
			await until("the run to be under way", () => heldRun.started, UNTIL_MS);
			const yielding = reloaded(true);
			await new Promise((later) => setImmediate(later));
			holdForMove(id, "background");
			let yieldingDuring: string;
			let otherDuring: string;
			try {
				heldRun.release?.();
				await answering;
				yieldingDuring = await yielding;
				otherDuring = await reloaded(false);
			} finally {
				letMoveGo(id);
			}
			const yieldingAfter = await reloaded(true);
			await host.close(id);
			return {
				firstId: id,
				moveHeld: { yieldingDuring, otherDuring, yieldingAfter },
			};
		},
	},
	/** Answer, start a new conversation from an extension's command, answer there, then stop. */
	replace: {
		responses: () => [say("hello there"), say("fine, thanks")],
		run: async (engine, host) => {
			const first = await open(engine, { first: "hi" });
			await idle(engine, first);
			await host.run(first, () => prompt(engine, first, "/probe-new"));
			const next = became[0]?.sessionId ?? "";
			await host.run(next, () => prompt(engine, next, "and you"));
			await idle(engine, next);
			const seen = {
				firstId: first,
				firstViewed: engine.view(first) !== undefined,
				held: host.list().map((conversation) => conversation.id),
				...summary(engine, next),
				header: JSON.parse(
					readFileSync(readEntry().file, "utf8").split("\n")[0] ?? "null",
				),
				env: envOf(host, next),
			};
			await host.stop(next);
			return seen;
		},
	},
	/** Start a new conversation from an extension's command whose store can't open, so pi fails past its teardown. */
	"replace-lost": {
		responses: () => [say("hello there")],
		run: async (engine, host) => {
			const first = await open(engine, { first: "hi" });
			await idle(engine, first);
			refusedStore = "next";
			// pi's runner says the failed command to the binding, so the probe
			// notes what it was refused; a prompt that fails anyway is kept, so a
			// wait that gives up shows why.
			let refused = "";
			await host
				.run(first, () => prompt(engine, first, "/probe-new"))
				.catch((error: unknown) => {
					refused = error instanceof Error ? error.message : String(error);
				});
			await until(
				`the conversation it was to be let go (${refused})`,
				() => host.holds(first) === undefined,
				UNTIL_MS,
			);
			return {
				firstId: first,
				refused,
				held: host.list().map((conversation) => conversation.id),
			};
		},
	},
	/** Start a new conversation from an extension's command at a screen that rebinds, then stop. */
	"replace-rebound": {
		responses: () => [say("hello there")],
		screens: rebindingScreens,
		run: async (engine, host) => {
			const first = await open(engine, { first: "hi" });
			await idle(engine, first);
			await host.run(first, () => prompt(engine, first, "/probe-new"));
			await until(
				"the conversation it was to be let go",
				() => host.holds(first) === undefined,
				UNTIL_MS,
			);
			const seen = { firstId: first, rebounds };
			for (const conversation of host.list()) await host.stop(conversation.id);
			return seen;
		},
	},
	/** Open on a store that can't open, so the build fails once the host holds it. */
	"start-fails": {
		responses: () => [],
		run: async (engine, host) => {
			refusedStore = "opened";
			let refused = "";
			try {
				await open(engine, {});
			} catch (error) {
				refused = error instanceof Error ? error.message : String(error);
			}
			const id = readEntry().sessionId;
			const state = host.holds(id) ?? "gone";
			// A park before it carried calls, whose record a close for good of
			// one held but not running stops and forgets (#1981 F27).
			const wake = host.env(id).snapshot()[WAKE_ENV];
			if (wake === undefined) throw new Error(`${id} was given no wake file`);
			const record = join(dirname(wake), "carried-calls.json");
			mkdirSync(dirname(wake), { recursive: true });
			writeFileSync(record, "[]\n");
			// The host disposes only once it holds nothing.
			await host.close(id);
			return { refused, state, recordLeft: existsSync(record) };
		},
	},
	/** Open with no words and sit, until the host says it collected the build's garbage. */
	"open-collected": {
		responses: () => [],
		run: async (engine, host) => {
			const id = await open(engine, {});
			await until(
				"the host to collect once the build settled",
				collectedQuietly,
				COLLECTED_WITHIN_MS,
			);
			await host.stop(id);
			return {};
		},
	},
	/** Open on a store that can't open, and sit with it parked until the host collects. */
	"start-fails-collected": {
		responses: () => [],
		run: async (engine, host) => {
			refusedStore = "opened";
			const failed = await open(engine, {}).then(
				() => false,
				// The open fails as start-fails shows; what follows is the collection.
				() => true,
			);
			if (!failed) throw new Error("the open on a refused store was built");
			const id = readEntry().sessionId;
			await until(
				"the host to collect once the failed build settled",
				collectedQuietly,
				COLLECTED_WITHIN_MS,
			);
			await host.close(id);
			return {};
		},
	},
	/** Leave one start asking its person about its folder, build another beside it, and sit until the host collects. */
	"asking-collected": {
		responses: () => [],
		screens: trustScreens,
		run: async (engine, host) => {
			const asking = await open(
				engine,
				{},
				{ cwd: project("asking"), attended: true },
			);
			if (trustAsked.length !== 1)
				throw new Error("the start in an untrusted folder never asked");
			const built = await open(engine, {});
			await until(
				"the host to collect while a start waits on its person",
				collectedQuietly,
				COLLECTED_WITHIN_MS,
			);
			await host.close(asking);
			await host.stop(built);
			return {};
		},
	},
	/**
	 * Hold one build in its load, build another beside it and sit past the
	 * settle: no collection while the first is under way, one once it is let go.
	 */
	"held-build-collected": {
		responses: () => [],
		run: async (engine, host) => {
			let release = (): void => {
				// Set once the held build reaches its load.
			};
			let reached = false;
			Reflect.set(globalThis, BUILD_HOLD, () => {
				// Only the first build is held; the one beside it loads straight through.
				Reflect.deleteProperty(globalThis, BUILD_HOLD);
				reached = true;
				return new Promise<void>((letGo) => {
					release = letGo;
				});
			});
			const holding = open(engine, {});
			// A build that settles without reaching its hold is named at once, not after the whole wait.
			let settled = false;
			const settle = (): void => {
				settled = true;
			};
			holding.then(settle, settle);
			await until(
				"the held build to reach its load",
				() => reached || settled,
				UNTIL_MS,
			);
			if (!reached) {
				throw new Error("the held build settled without reaching its load");
			}
			const built = await open(engine, {});
			// Twice the settle after the second build settled, which alone would bring a collection.
			await quietFor(SETTLE_MS, 2);
			const collectedWhileHeld = collectedQuietly();
			release();
			const held = await holding;
			await until(
				"the host to collect once the held build settled",
				collectedQuietly,
				COLLECTED_WITHIN_MS,
			);
			await host.stop(held);
			await host.stop(built);
			return { collectedWhileHeld };
		},
	},
	/** A conversation's launch names a gateway key of its own, and the host has another. */
	"own-key": {
		responses: () => [say("hello there")],
		launch: { SHOPIFY_PROXY_KEY: "its-own-key" },
		run: answerOnce,
	},
	/** The same for the proxy's key, the provider reading it. */
	"own-proxy-key": {
		responses: () => [say("hello there")],
		keyVariable: "PI_PROXY_API_KEY",
		launch: { PI_PROXY_API_KEY: "its-own-key" },
		run: answerOnce,
	},
	/**
	 * One conversation on a budget, whose key the quest workflow lays
	 * over its environment under both names the proxy's key goes by, as
	 * a team's agent key is laid; it answers and is warmed parked. Then
	 * a personal one, on no budget, answers.
	 */
	"budget-key": {
		api: "anthropic-messages",
		responses: () => [say("hello there"), say(""), say("hello there")],
		run: async (engine, host) => {
			const team = await open(engine, {});
			layBudget(
				host.env(team),
				{
					name: "team",
					label: "Team",
					env: {
						SHOPIFY_PROXY_KEY: "team-key",
						PI_PROXY_API_KEY: "team-key",
						PI_PROXY_AUTH_HEADER: "Bearer team-key",
					},
				},
				emptyOverlay(),
			);
			await host.run(team, () => prompt(engine, team, "hi"));
			await idle(engine, team);
			const turn = keysSeen.length;
			writeDueCarry(team);
			host.park(team);
			await warmed(turn);
			const warm = keysSeen.length;
			const personal = await open(engine, { first: "hi" });
			await idle(engine, personal);
			await host.close(personal);
			return {
				budgetKeys: {
					turn: keysSeen.slice(0, turn),
					warm: keysSeen.slice(turn, warm),
					personal: keysSeen.slice(warm),
				},
			};
		},
	},
	/** The provider's key is read from a variable only the host's process holds. */
	"host-read": {
		responses: () => [say("hello there")],
		keyVariable: "PI_HYPERLINKS",
		hostEnv: { PI_HYPERLINKS: "the-host-read" },
		run: answerOnce,
	},
	/** The same, with the conversation's launch naming the variable for itself. */
	"own-read": {
		responses: () => [say("hello there")],
		keyVariable: "PI_HYPERLINKS",
		hostEnv: { PI_HYPERLINKS: "the-host-read" },
		launch: { PI_HYPERLINKS: "its-own-read" },
		run: answerOnce,
	},
	/** A heavy run and a light one handed to the job host, read as a restart's hold and as a drain's answer. */
	"heavy-held": {
		responses: () => [],
		harness: true,
		run: async (engine, host) => {
			const id = await open(engine, {});
			await idle(engine, id);
			await host.run(id, () =>
				prompt(engine, id, "/probe-job nix-offload there --changed"),
			);
			await idle(engine, id);
			// A light run beside it, which a drain doesn't name.
			await host.run(id, () => prompt(engine, id, "/probe-job"));
			await idle(engine, id);
			const holding = engine.holding();
			// No await between the drain and its lift, so nothing parks for it.
			const drained = engine.drain?.(true);
			const holdingDrained = engine.holding();
			engine.drain?.(false);
			await host.close(id);
			return {
				firstId: id,
				heavyHeld: { holding, drained, holdingDrained },
			};
		},
	},
	/** Ask one conversation to resume the file another holds, then talk on in the first. */
	"replace-held": {
		responses: () => [say("hello there"), say("still here")],
		run: async (engine, host) => {
			const first = await open(engine, { first: "hi" });
			await idle(engine, first);
			const other = await open(engine, {});
			let refused = "";
			try {
				await host.run(first, () =>
					engine.view(first)?.runtime.switchSession(readEntry().file),
				);
			} catch (error) {
				refused = error instanceof Error ? error.message : String(error);
			}
			await host.run(first, () => prompt(engine, first, "still there"));
			await idle(engine, first);
			const seen = {
				refused,
				held: host
					.list()
					.map((conversation) => conversation.id)
					.sort((a, b) => a.localeCompare(b, "en")),
				bothIds: [first, other].sort((a, b) => a.localeCompare(b, "en")),
				...summary(engine, first),
			};
			await host.close(first);
			await host.close(other);
			return seen;
		},
	},
	/**
	 * Open in folders holding their own extension: one with nobody to ask,
	 * one pi's trust store trusts, one whose screen asks and is answered, and
	 * one closed while its screen asks.
	 */
	trust: {
		responses: () => [],
		screens: trustScreens,
		run: async (engine, host) => {
			const nobodyDir = project("nobody");
			const storedDir = project("stored");
			const askedDir = project("asked");
			const closingDir = project("closing");
			writeFileSync(
				join(agentDir, "trust.json"),
				JSON.stringify({ [storedDir]: true }),
			);
			const nobody = await open(engine, {}, { cwd: nobodyDir });
			const stored = await open(engine, {}, { cwd: storedDir });
			const asked = await open(engine, {}, { cwd: askedDir, attended: true });
			const answeredWhileAsking =
				engine.view(asked) === undefined && trustAsked.length === 1;
			const question = trustAsked[0];
			question?.answer(TRUST_THIS_SESSION);
			await until(
				"the answered conversation to be built",
				() => screensOpened.has(asked),
				UNTIL_MS,
			);
			const closing = await open(
				engine,
				{},
				{ cwd: closingDir, attended: true },
			);
			await host.close(closing);
			await until(
				"the closed conversation's build to end",
				() =>
					reported.some((said) => said.includes("closed before it was built")),
				UNTIL_MS,
			);
			const seen = {
				answeredWhileAsking,
				question: question && {
					asked: question.sessionId === asked,
					cwd: question.cwd === askedDir,
					title: question.title,
					labels: question.labels,
				},
				questionsFor: trustAsked.map(({ cwd }) => basename(cwd)),
				closingScreenClosed: screensClosed.includes(closing),
				closingHeld: host.holds(closing) ?? "gone",
				nobodySaid: engine.view(nobody)?.runtime.diagnostics,
				built: [nobody, stored, asked].map(
					(id) => engine.view(id) !== undefined,
				),
			};
			for (const id of [nobody, stored, asked]) await host.close(id);
			return { ...seen, projectLoads: lines(projectLoads) };
		},
	},
	/**
	 * Code planted in trusted folders after the host first looked: one
	 * opened with nobody to ask; one beside code the host found there,
	 * reloaded, then reloaded again once the planted file is gone; one
	 * whose screen is asked and allows it; one whose screen says no; and
	 * one whose code changes while its screen is asked, then says yes.
	 */
	"planted-code": {
		responses: () => [],
		screens: trustScreens,
		run: async (engine, host) => {
			const foundDir = project("found");
			const names = ["planted", "asked", "refused", "swapped"] as const;
			const [plantedDir, askedDir, refusedDir, swappedDir] = names.map((name) =>
				emptyProject(name),
			);
			if (!plantedDir || !askedDir || !refusedDir || !swappedDir)
				throw new Error("Every project folder should be made");
			writeFileSync(
				join(agentDir, "trust.json"),
				JSON.stringify(
					Object.fromEntries(
						[foundDir, plantedDir, askedDir, refusedDir, swappedDir].map(
							(dir) => [dir, true],
						),
					),
				),
			);
			const found = await open(engine, {}, { cwd: foundDir });
			for (const name of names) project(name);
			const planted = await open(engine, {}, { cwd: plantedDir });
			projectExtension(foundDir, "beside", "found beside");
			const runtime = engine.view(found)?.runtime;
			if (!runtime) throw new Error("The found conversation has no runtime");
			await runtime.session.reload();
			rmSync(join(foundDir, ".pi", "extensions", "beside.ts"));
			await runtime.session.reload();
			/** Open `dir` with a screen, and give its question `answer` once `meanwhile` has run. */
			const answered = async (
				dir: string,
				answer: string,
				meanwhile: () => void = () => {},
			) => {
				const before = trustAsked.length;
				const id = await open(engine, {}, { cwd: dir, attended: true });
				await until(
					`${basename(dir)}'s screen to be asked`,
					() => trustAsked.length > before,
					UNTIL_MS,
				);
				meanwhile();
				trustAsked[before]?.answer(answer);
				await until(
					`${basename(dir)}'s conversation to be built`,
					() => screensOpened.has(id),
					UNTIL_MS,
				);
				return id;
			};
			const asked = await answered(askedDir, "Yes");
			const question = trustAsked[0];
			const refused = await answered(refusedDir, "No");
			const swapped = await answered(swappedDir, "Yes", () =>
				projectExtension(swappedDir, "swapped", "swapped in"),
			);
			const seen = {
				question: question && {
					asked: question.sessionId === asked,
					title: question.title,
					labels: question.labels,
				},
				questionsFor: trustAsked.map(({ cwd }) => basename(cwd)),
				nobodySaid: engine.view(planted)?.runtime.diagnostics,
				swappedSaid: engine.view(swapped)?.runtime.diagnostics,
			};
			for (const id of [found, planted, asked, refused, swapped])
				await host.close(id);
			return { ...seen, projectLoads: lines(projectLoads) };
		},
	},
	/**
	 * An extension linked into pi's folder, as Shopify's proxy is, whose
	 * link moves onto another copy and whose first copy is then deleted,
	 * as a switch and a store collection do: the first conversation
	 * reloads, and a second is built, in the same process.
	 */
	"extension-moved": {
		responses: () => [],
		run: async (engine, host) => {
			const link = join(agentDir, "extensions", "linked");
			const copies = join(folder, "copies");
			for (const copy of ["first", "second"])
				linkedCopy(join(copies, copy), copy);
			symlinkSync(join(copies, "first"), link);
			const first = await open(engine, {});
			symlinkSync(join(copies, "second"), `${link}.next`);
			renameSync(`${link}.next`, link);
			rmSync(join(copies, "first"), { recursive: true });
			const runtime = engine.view(first)?.runtime;
			if (!runtime) throw new Error("The first conversation has no runtime");
			await runtime.session.reload();
			const afterReload = piModule<{
				getExtensions(): { errors: readonly { error: string }[] };
			}>(runtime.services.resourceLoader)
				.getExtensions()
				.errors.map((failed) => failed.error);
			const second = await open(engine, {});
			await host.close(first);
			await host.close(second);
			return { afterReload, linked: lines(linkedLoads) };
		},
	},
	/** The host's next start, resuming nothing, as when the last run's hold was dropped or its resume fails. */
	start: {
		responses: () => [],
		run: async () => ({}),
	},
	/** A child's start on the same key: its siblings' work is the supervisor's. */
	"child-start": {
		responses: () => [],
		oneConversation: true,
		run: async () => ({}),
	},
	/** The host's next start: resume what the last run held, then talk. */
	resume: {
		responses: () => [say("after the restart"), say("and again")],
		run: async (engine, host) => {
			const entry = readEntry();
			await engine.resume(entry);
			await idle(engine, entry.sessionId);
			const view = engine.view(entry.sessionId);
			await view?.runtime.session.prompt("are you there");
			await idle(engine, entry.sessionId);
			const seen = {
				...summary(engine, entry.sessionId),
				env: envOf(host, entry.sessionId),
				// pi's runtime has the folder it runs in; the engine's narrow type leaves it out.
				cwd: (view?.runtime as unknown as { readonly cwd?: string } | undefined)
					?.cwd,
				heldIn: host
					.list()
					.find((conversation) => conversation.id === entry.sessionId)?.cwd,
			};
			await host.close(entry.sessionId);
			return seen;
		},
	},
};

if (scenarioName === "reopen") await reopen();
else await runHost(scenarios[scenarioName]);

/** How many listeners the process holds for each event it has any for. */
function processListeners(): Record<string, number> {
	return Object.fromEntries(
		process
			.eventNames()
			.map((name) => [String(name), process.listenerCount(name)]),
	);
}

/** Park a conversation as it asks once idle, and wait for the park to settle. */
async function parkNow(
	engine: HostEngine,
	host: SessionHost,
	id: string,
): Promise<void> {
	host.park(id);
	// The park starts a turn after it is asked for.
	await new Promise((later) => setImmediate(later));
	await engine.parkSettled?.(id);
}

/** Each descriptor this process holds open on `file`, as `read` or `write`. */
function logHolds(file: string): string[] {
	const real = realpathSync(file);
	const holds: string[] = [];
	for (const fd of readdirSync("/proc/self/fd")) {
		let target = "";
		try {
			target = readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			// Closed between the listing and the look, as the listing's own is.
			continue;
		}
		if (target !== real) continue;
		const flags = /^flags:\s+(\d+)/m.exec(
			readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"),
		)?.[1];
		const mode =
			flags === undefined ? undefined : Number.parseInt(flags, 8) & ACCESS_MODE;
		holds.push(mode === READ_ONLY ? "read" : "write");
	}
	return holds;
}

/** The pids the crashing tool wrote down, if it ran. */
function leftRunning(): number[] {
	return existsSync(children)
		? readFileSync(children, "utf8").split("\n").filter(Boolean).map(Number)
		: [];
}

/** Whether a process still runs, a zombie counting as ended. */
function alive(pid: number): boolean {
	try {
		return !/^\S+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// No such process.
		return false;
	}
}

/** What of a conversation's environment the engine set: its launch, its harness settings and its marker. */
function envOf(host: SessionHost, id: string): Record<string, unknown> {
	const env = host.env(id).snapshot();
	const settings = env.SHOPIFY_HARNESS_SETTINGS;
	return {
		openedAs: env[OPENED_AS],
		marker: env.PI_HOST_CONVERSATION,
		settings: settings === undefined ? undefined : JSON.parse(settings),
	};
}

/** Read the last run's file with ordinary pi's session manager and no host. */
async function reopen(): Promise<void> {
	const codingAgent = piModule<{
		SessionManager: {
			open(path: string): {
				getSessionId(): string;
				buildSessionContext(): { readonly messages: readonly Message[] };
			};
		};
	}>(await import(pathToFileURL(join(packageDir, "dist", "index.js")).href));
	const entry = readEntry();
	const manager = codingAgent.SessionManager.open(entry.file);
	process.stdout.write(
		`${JSON.stringify({
			sessionId: manager.getSessionId(),
			transcript: manager.buildSessionContext().messages.map(text),
		})}\n`,
	);
}

/** Run one step of the host's life: its engine, a conversation, and what they saw. */
async function runHost(scenario: Scenario | undefined): Promise<void> {
	if (!scenario) throw new Error(`no scenario ${scenarioName}`);
	mkdirSync(work, { recursive: true });
	if (!existsSync(workLink)) symlinkSync(work, workLink);
	writeFileSync(
		flaggedExtension,
		[
			'import { appendFileSync } from "node:fs";',
			"export default async function () {",
			`\tappendFileSync(${JSON.stringify(flaggedLoads)}, ${JSON.stringify(`${JSON.stringify({ loaded: true })}\n`)});`,
			`\tconst hold = globalThis[Symbol.for(${JSON.stringify(BUILD_HOLD.description)})];`,
			'\tif (typeof hold === "function") await hold();',
			"}",
			"",
		].join("\n"),
	);
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const faux = compat.registerFauxProvider({
		tokenSize: { min: 2, max: 2 },
		...(scenario.api ? { api: scenario.api } : {}),
	});
	faux.setResponses(scenario.responses());
	writeAgentFolder(
		faux.api,
		scenario.harness ? [HARNESS] : [],
		scenario.keyVariable,
	);
	Object.assign(process.env, scenario.hostEnv);
	// pi counts any .agents/skills above a folder but HOME's as a project's own, and this folder may sit under a
	// home holding one, so the work folder is trusted as its person would have trusted it.
	writeFileSync(
		join(agentDir, "trust.json"),
		JSON.stringify({ [realpathSync(work)]: true }),
	);

	const host = new sessionHosts.SessionHost({
		// A key of the folder's own, as each real host has: a start reaps what a dead host under its key left.
		key: `test-host-${basename(folder)}`,
		owner: { pid: process.pid, startedAt: Date.now() },
		registryDir: join(folder, "registry"),
	});
	runningHost = host;
	const engine = await createEngine({
		packageDir,
		stateDir: join(folder, "state"),
		host,
		env: { PATH: process.env.PATH ?? "" },
		key,
		conversationEnv: (_traits, request) => {
			derived.push(request.op);
			return { [OPENED_AS]: request.op, ...scenario.launch };
		},
		resources: { extensions: [flaggedExtension] },
		...(scenario.oneConversation
			? {
					oneConversation: {
						keptIn: () => join(folder, "state", "child"),
					},
				}
			: {}),
		...(scenario.screens ? { screens: scenario.screens() } : {}),
		report: noteReported,
	});
	// As the service's roster does: the conversation a held one became replaces it, in one write.
	engine.watch({
		became: async (previousId, next) => {
			if (refusedStore === "next") refuseStore(next.sessionId);
			became.push({
				previousId,
				sessionId: next.sessionId,
				held: host.holds(next.sessionId) ?? "not yet",
			});
			const entry: RosterEntry = {
				...readEntry(),
				sessionId: next.sessionId,
				file: next.file,
				cwd: next.cwd,
				...(next.launch ? { launch: next.launch } : {}),
			};
			writeFileSync(entryFile, JSON.stringify(entry));
		},
		ended: async (sessionId, why) => {
			ended.push({ sessionId, why });
		},
	});
	const { VERSION } = piModule<{ VERSION: string }>(
		await import(pathToFileURL(join(packageDir, "dist", "index.js")).href),
	);
	// Counted once pi is loaded, whose own modules add process listeners at import.
	const listenersAtStart = processListeners();
	const result = await scenario.run(engine, host);
	// What the engine says of an end comes a turn after the close.
	await new Promise((settled) => setImmediate(settled));
	const listeners = { atStart: listenersAtStart, atEnd: processListeners() };
	process.stdout.write(
		`${JSON.stringify({
			...result,
			piVersion: VERSION,
			derived,
			keysSeen,
			registeredHeadersSeen,
			ran: existsSync(effects)
				? readFileSync(effects, "utf8").split("\n").filter(Boolean).length
				: 0,
			childrenAlive: leftRunning().filter(alive),
			probe: existsSync(probe)
				? readFileSync(probe, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
			installs: lines(installs),
			as: lines(runsAs),
			became,
			ended,
			openedIn,
			work: realpathSync(work),
			flagged: lines(flaggedLoads),
			listeners,
			reported,
		})}\n`,
	);
	host.dispose();
}

async function open(
	engine: HostEngine,
	words: { first?: string },
	where: { cwd?: string; attended?: boolean } = {},
): Promise<string> {
	const attended = where.attended ?? false;
	const request = {
		v: 1 as const,
		id: "open-1",
		op: "open" as const,
		cwd: where.cwd ?? workLink,
		attended,
		model: { provider: PROVIDER, id: MODEL },
		...words,
	};
	const prepared = await engine.prepare(request);
	if (refusedStore === "opened") refuseStore(prepared.sessionId);
	openedIn.push(prepared.cwd);
	const entry: RosterEntry = {
		sessionId: prepared.sessionId,
		file: prepared.file,
		cwd: prepared.cwd,
		attended,
		since: new Date().toISOString(),
		// The roster holds the launch the engine derived, as the service's does.
		...(prepared.launch ? { launch: prepared.launch } : {}),
	};
	writeFileSync(entryFile, JSON.stringify(entry));
	await engine.start(prepared, request);
	return prepared.sessionId;
}

/** A session manager as kept history leaves it: its entries, header first. */
interface HeldLog {
	readonly fileEntries: readonly {
		readonly type: string;
		readonly id?: string;
		readonly parentId?: string | null;
		readonly customType?: string;
		readonly message?: Message;
	}[];
	getBranch(): readonly {
		readonly id: string;
		readonly parentId: string | null;
		readonly message?: Message;
	}[];
	appendCompaction(
		summary: string,
		firstKeptEntryId: string,
		tokens: number,
	): string;
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** The parts of a conversation's session /session and /fork read. */
interface CountedSession {
	getSessionStats(): { readonly userMessages: number };
	getUserMessagesForForking(): readonly { readonly text: string }[];
}

/** A conversation's session, as /session and /fork read it. */
function sessionOf(engine: HostEngine, id: string): CountedSession | undefined {
	return engine.view(id)?.runtime.session as unknown as
		| CountedSession
		| undefined;
}

/** The session manager a held conversation reads its log through. */
function logOf(engine: HostEngine, id: string): HeldLog | undefined {
	const session = engine.view(id)?.runtime.session as unknown as
		| { readonly sessionManager: HeldLog }
		| undefined;
	return session?.sessionManager;
}

/**
 * Open a conversation, talk three turns, compact it from its second
 * user message on, and close it: its roster entry, the first entry the
 * compaction keeps, and that entry's parent. A `record` of the custom type
 * given follows the first turn, among the state the compaction keeps.
 */
async function compacted(
	engine: HostEngine,
	host: SessionHost,
	record?: string,
): Promise<{ entry: RosterEntry; kept: string; parent: string | null }> {
	const id = await open(engine, { first: "early" });
	await idle(engine, id);
	if (record) logOf(engine, id)?.appendCustomEntry(record, { early: true });
	await prompt(engine, id, "kept");
	await idle(engine, id);
	await prompt(engine, id, "after");
	await idle(engine, id);
	const entry = readEntry();
	const log = logOf(engine, id);
	const said = (words: string) =>
		log
			?.getBranch()
			.find((each) => each.message && text(each.message) === `user: ${words}`);
	const kept = said("kept");
	// Either missing, the case below would hold nothing to tell a kept view from a whole log.
	if (!log || !kept || !said("early"))
		throw new Error(`Conversation ${id} doesn't hold what it was told`);
	log.appendCompaction("talked early on", kept.id, 1000);
	await host.close(id);
	return { entry, kept: kept.id, parent: kept.parentId };
}

/**
 * What a conversation holds of its compacted log: the rollover record
 * kept history writes in place of what it leaves out, whether the entry
 * the compaction keeps is held with its parent on disk held before it, as
 * /fork from it needs, and whether
 * the turn before it is still held; the user messages its session
 * counts for /session and lists for /fork, which take in those left out;
 * and whether the light open stood its manager with entries read lighter.
 */
function heldOf(
	engine: HostEngine,
	id: string,
	{ kept, parent }: { kept: string; parent: string | null },
): Record<string, unknown> {
	const entries = logOf(engine, id)?.fileEntries ?? [];
	const record = entries.findIndex(
		(entry) => entry.type === "custom" && entry.customType === ROLLOVER_RECORD,
	);
	return {
		record: record !== -1,
		keptAfterItsParent:
			parent !== null &&
			entries.find((entry) => entry.id === kept)?.parentId === parent &&
			entries.some((entry) => entry.id === parent),
		earlyHeld: entries.some(
			(entry) =>
				entry.message !== undefined && text(entry.message) === "user: early",
		),
		userMessages: sessionOf(engine, id)?.getSessionStats().userMessages,
		forks: sessionOf(engine, id)
			?.getUserMessagesForForking()
			.map((point) => point.text),
		light: heldLight(logOf(engine, id)),
	};
}

/** Each line of a file the probe writes, read as JSON. */
function lines(file: string): unknown[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

/** Say something to a conversation, as its screen would. */
async function prompt(
	engine: HostEngine,
	id: string,
	text: string,
): Promise<void> {
	await engine.view(id)?.runtime.session.prompt(text);
}

async function idle(engine: HostEngine, id: string): Promise<void> {
	await engine.view(id)?.runtime.session.waitForIdle();
}

function readEntry(): RosterEntry {
	return JSON.parse(readFileSync(entryFile, "utf8"));
}

/** What a conversation ended with: its id, its file, and its transcript as text. */
function summary(engine: HostEngine, id: string): Record<string, unknown> {
	const session = engine.view(id)?.runtime.session as unknown as {
		readonly sessionId: string;
		readonly sessionFile: string;
		readonly agent: {
			readonly state: { readonly messages: readonly Message[] };
		};
	};
	return {
		sessionId: session.sessionId,
		sameId: session.sessionId === id,
		file: session.sessionFile,
		transcript: session.agent.state.messages.map(text),
	};
}

interface Message {
	readonly role: string;
	/** Absent on a message pi makes of an entry, such as a compaction's summary. */
	readonly content?: string | readonly { type: string; text?: string }[];
}

function text(message: Message): string {
	const content =
		message.content === undefined
			? ""
			: typeof message.content === "string"
				? message.content
				: message.content
						.map((part) =>
							part.type === "text" ? part.text : `[${part.type}]`,
						)
						.join("");
	return `${message.role}: ${content}`;
}

/**
 * A copy of the linked extension: its entry imports a helper beside it,
 * as Shopify's proxy imports its own, and notes the helper's word at
 * each load.
 */
function linkedCopy(dir: string, word: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "helper.ts"),
		`export const copy = ${JSON.stringify(word)};\n`,
	);
	writeFileSync(
		join(dir, "index.ts"),
		[
			'import { appendFileSync } from "node:fs";',
			'import { copy } from "./helper.js";',
			"export default function () {",
			`\tappendFileSync(${JSON.stringify(linkedLoads)}, \`\${JSON.stringify({ copy })}\\n\`);`,
			"}",
			"",
		].join("\n"),
	);
}

/**
 * pi's agent folder: the scripted provider with the gateway key's
 * variable, in models.json or registered by an extension of its own,
 * settings, and the probe.
 */
function writeAgentFolder(
	api: string,
	packages: readonly string[],
	keyVariable = "SHOPIFY_PROXY_KEY",
): void {
	const provider = {
		baseUrl: "http://faux.invalid",
		api,
		apiKey: `$${keyVariable}`,
		models: [
			{
				id: MODEL,
				name: "Faux",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: providerByExtension ? {} : { [PROVIDER]: provider },
		}),
	);
	if (providerByExtension)
		writeFileSync(
			join(agentDir, "extensions", "provider.ts"),
			[
				"export default function (pi) {",
				`\tpi.registerProvider(${JSON.stringify(PROVIDER)}, ${JSON.stringify({
					...provider,
					headers: { [KEPT_HEADER]: "its-extension" },
				})});`,
				"}",
				"",
			].join("\n"),
		);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: PROVIDER,
			defaultModel: MODEL,
			packages,
			// The harness's codemode takes the built-in's place, as Joel's
			// settings say; without this, pi warns of it at every start.
			extensions: ["-builtin:codemode"],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	copyFileSync(
		join(import.meta.dirname, "probe-extension.mts"),
		join(agentDir, "extensions", "probe.ts"),
	);
}
