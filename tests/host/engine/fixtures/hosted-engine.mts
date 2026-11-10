// One step of a host's life on the engine, run by node as the host runs: it prints what the conversation and its extensions saw.
/**
 * Run as `node hosted-engine.mts <package dir> <folder> <scenario>`, with
 * HOME inside the folder, so pi's agent folder, its settings, models and
 * extensions are the folder's. The folder outlives a run, so a later run
 * plays the host's next start: entry.json is the roster entry a run held,
 * effects counts what a tool really did, and probe.jsonl is what the
 * probe extension saw. It prints one JSON line.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	EngineKey,
	HostEngine,
} from "../../../../host/engine/contract.ts";
import { createEngine } from "../../../../host/engine/engine.ts";
import { SessionHost } from "../../../../host/engine/session-host.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";

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

const say =
	(text: string) => (_context: unknown, options: { apiKey?: unknown }) => {
		keysSeen.push(options.apiKey);
		return compat.fauxAssistantMessage(text);
	};

interface Scenario {
	responses: () => unknown[];
	/** Whether pi loads this package, as Joel's settings have it, beside the probe. */
	harness?: true;
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
	const faux = compat.registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
	faux.setResponses(scenario.responses());
	writeAgentFolder(faux.api, scenario.harness ? [HARNESS] : []);

	const host = new SessionHost({
		// A key of the folder's own, as each real host has: a start reaps what a dead host under its key left.
		key: `test-host-${basename(folder)}`,
		owner: { pid: process.pid, startedAt: Date.now() },
		registryDir: join(folder, "registry"),
	});
	const reported: string[] = [];
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
): Promise<string> {
	const request = {
		v: 1 as const,
		id: "open-1",
		op: "open" as const,
		cwd: workLink,
		attended: false,
		model: { provider: PROVIDER, id: MODEL },
		...words,
	};
	const prepared = await engine.prepare(request);
	openedIn.push(prepared.cwd);
	const entry: RosterEntry = {
		sessionId: prepared.sessionId,
		file: prepared.file,
		cwd: prepared.cwd,
		attended: false,
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
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	copyFileSync(
		join(import.meta.dirname, "probe-extension.mts"),
		join(agentDir, "extensions", "probe.ts"),
	);
}
