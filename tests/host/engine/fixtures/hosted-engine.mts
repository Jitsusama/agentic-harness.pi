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
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createEngine,
	type EngineKey,
	type HostEngine,
} from "../../../../host/engine/engine.ts";
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

const PROVIDER = "hosted-faux";
const MODEL = "faux-1";
const work = join(folder, "work");
const agentDir = join(folder, "home", ".pi", "agent");
const entryFile = join(folder, "entry.json");
const effects = join(folder, "effects");
/** The pids of what the crashing tool left running, one in its group and one that left it. */
const children = join(folder, "children");
const probe = join(folder, "probe.jsonl");
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
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const faux = compat.registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
	faux.setResponses(scenario.responses());
	writeAgentFolder(faux.api);

	const host = new SessionHost({
		key: "test-host",
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
		report: (error) => reported.push(String(error)),
	});
	const { VERSION } = piModule<{ VERSION: string }>(
		await import(pathToFileURL(join(packageDir, "dist", "index.js")).href),
	);
	const result = await scenario.run(engine, host);
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
		cwd: work,
		attended: false,
		model: { provider: PROVIDER, id: MODEL },
		...words,
	};
	const prepared = await engine.prepare(request);
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
function writeAgentFolder(api: string): void {
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
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	copyFileSync(
		join(import.meta.dirname, "probe-extension.mts"),
		join(agentDir, "extensions", "probe.ts"),
	);
}
