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
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	EngineKey,
	EngineScreens,
	HostEngine,
} from "../../../../host/engine/contract.ts";
import { createEngine } from "../../../../host/engine/engine.ts";
import { SessionHost } from "../../../../host/engine/session-host.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";
import {
	LONG_CACHE_LIFETIME_MS,
	warmingDelayMs,
} from "../../../../lib/internal/cache-warming.ts";
import {
	WAKE_ENV,
	writeParked,
} from "../../../../lib/internal/session/park.ts";
import {
	pendingWarmsDir,
	takePendingWarms,
	warmingCarryDir,
	writeWarmingCarry,
} from "../../../../lib/internal/warming-carry.ts";
import { watchSpawns } from "../../../support/spawns.ts";

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
/** Which copy of the linked extension each of its loads ran, as its helper module named it. */
const linkedLoads = join(folder, "linked.jsonl");
const agentDir = join(folder, "home", ".pi", "agent");
const entryFile = join(folder, "entry.json");
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
/** The request each launch environment was derived for, in this run. */
const derived: string[] = [];
/** The variable the fixture's launch environment sets. */
const OPENED_AS = "OPENED_AS";
/** What the engine reported, in this run. */
const reported: string[] = [];
/** Project folders, each with an extension of its own that notes its loads in projectLoads. */
const projects = join(folder, "projects");
const projectLoads = join(folder, "project-loads.jsonl");
/** The label pi's trust question offers for trusting a folder for this session alone. */
const TRUST_THIS_SESSION = "Trust (this session only)";
/** How long a condition the fixture waits on may take, and how often it looks. */
const UNTIL_MS = 60_000;
const LOOK_MS = 10;

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

/** A project folder holding an extension of its own, which pi loads only where the folder is trusted. */
function project(name: string): string {
	const dir = join(projects, name);
	mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "extensions", "project.ts"),
		[
			'import { appendFileSync } from "node:fs";',
			"export default function () {",
			`\tappendFileSync(${JSON.stringify(projectLoads)}, ${JSON.stringify(`${JSON.stringify({ loaded: name })}\n`)});`,
			"}",
			"",
		].join("\n"),
	);
	return realpathSync(dir);
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

/** Wait until a condition holds, refusing the run once it has waited too long. */
async function until(what: string, condition: () => boolean): Promise<void> {
	const deadline = Date.now() + UNTIL_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Gave up waiting until ${what}`);
		await new Promise((later) => setTimeout(later, LOOK_MS));
	}
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
		"its warm went out or failed",
		() => keysSeen.length > before || failed(),
	);
	await until(
		"its warm was kept or failed",
		() => existsSync(pendingWarmsDir()) || failed(),
	);
}

const say =
	(text: string) => (_context: unknown, options: { apiKey?: unknown }) => {
		keysSeen.push(options.apiKey);
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
			await until("the first words are answered", () =>
				String(summary(engine, id).transcript).includes("went on"),
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
			await until("the lost conversation's screen is told", () =>
				screenFailures.some(({ sessionId }) => sessionId === lost),
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
			await until("the answered conversation is built", () =>
				screensOpened.has(asked),
			);
			const closing = await open(
				engine,
				{},
				{ cwd: closingDir, attended: true },
			);
			await host.close(closing);
			await until("the closed conversation's build ends", () =>
				reported.some((said) => said.includes("closed before it was built")),
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
			"export default function () {",
			`\tappendFileSync(${JSON.stringify(flaggedLoads)}, ${JSON.stringify(`${JSON.stringify({ loaded: true })}\n`)});`,
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
	writeAgentFolder(faux.api, scenario.harness ? [HARNESS] : []);
	// pi counts any .agents/skills above a folder but HOME's as a project's own, and this folder may sit under a
	// home holding one, so the work folder is trusted as its person would have trusted it.
	writeFileSync(
		join(agentDir, "trust.json"),
		JSON.stringify({ [realpathSync(work)]: true }),
	);

	const host = new SessionHost({
		// A key of the folder's own, as each real host has: a start reaps what a dead host under its key left.
		key: `test-host-${basename(folder)}`,
		owner: { pid: process.pid, startedAt: Date.now() },
		registryDir: join(folder, "registry"),
	});
	const engine = await createEngine({
		packageDir,
		stateDir: join(folder, "state"),
		host,
		env: { PATH: process.env.PATH ?? "" },
		key,
		conversationEnv: (_traits, request) => {
			derived.push(request.op);
			return { [OPENED_AS]: request.op };
		},
		resources: { extensions: [flaggedExtension] },
		...(scenario.screens ? { screens: scenario.screens() } : {}),
		report: (error) => reported.push(String(error)),
	});
	// As the service's roster does: the conversation a held one became replaces it, in one write.
	engine.watch({
		became: async (previousId, next) => {
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
	readonly content: string | readonly { type: string; text?: string }[];
}

function text(message: Message): string {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content
					.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
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

/** pi's agent folder: the scripted provider with the gateway key's variable, settings, and the probe. */
function writeAgentFolder(api: string, packages: readonly string[]): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: "http://faux.invalid",
					api,
					apiKey: "$SHOPIFY_PROXY_KEY",
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
				},
			},
		}),
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
