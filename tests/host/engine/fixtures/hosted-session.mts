// One scripted pi session, on pi's own agent or the host's, run by node as the host runs: it prints what pi's listeners saw.
/**
 * Run as `node hosted-session.mts <package dir> <pi|hosted> <scenario>`,
 * with the package dir a pi built with the host's patches. It runs outside
 * vitest so pi's modules load once, as pi's, and the engine loads as the
 * host will load it, types stripped. It prints one JSON line: the events
 * pi's listeners saw and the transcript the agent ended with, with what
 * two runs of one script cannot share (times, folders, random ids) left
 * out.
 */
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHostPi } from "../../../../host/engine/host-pi.ts";
import { openHostedConversation } from "../../../../host/engine/hosted-conversation.ts";
import { piLibrary } from "../../../../host/engine/pi-library.ts";

/** What the fixture drives of a pi session. */
interface Session {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	navigateTree(targetId: string, options: object): Promise<unknown>;
	readonly sessionManager: {
		getEntries(): readonly {
			readonly id: string;
			readonly type: string;
			readonly message?: { readonly role: string };
		}[];
	};
	readonly agent: {
		subscribe(listener: (event: { readonly type: string }) => void): () => void;
		waitForIdle(): Promise<void>;
		readonly state: { readonly messages: readonly unknown[] };
	};
}

interface FauxModel extends Record<string, unknown> {
	readonly provider: string;
}

/** What the fixture uses of pi-ai's scripted provider. */
interface Compat {
	registerFauxProvider(options: object): {
		setResponses(responses: readonly unknown[]): void;
		getModel(): FauxModel;
		readonly models: readonly FauxModel[];
		unregister(): void;
	};
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options: { id: string }): unknown;
}

/** What the fixture uses of pi's coding agent. */
interface Coding {
	readonly ModelRuntime: {
		create(options: object): Promise<ModelRuntime>;
	};
	readonly SessionManager: {
		inMemory(cwd: string): unknown;
		create(cwd: string, sessionDir: string): unknown;
		open(path: string, sessionDir: string): unknown;
	};
	readonly SettingsManager: { inMemory(settings: object): unknown };
	createAgentSession(options: object): Promise<{ session: Session }>;
}

/** What the fixture uses of pi's model runtime. */
interface ModelRuntime {
	registerProvider(id: string, config: object): void;
	registerVirtualModel(definition: {
		provider: string;
		id: string;
		name: string;
		route(request: { readonly reason: string }): {
			model: unknown;
			thinkingLevel: string;
		};
	}): void;
	getModel(provider: string, id: string): FauxModel | undefined;
}

interface Auth {
	readonly AuthStorage: {
		inMemory(): {
			modify(provider: string, change: () => Promise<object>): Promise<void>;
		};
	};
}

/** A pi module as the fixture uses it: pi's JavaScript carries no types here, so the shape is declared above. */
function piModule<T>(module: unknown): T {
	return module as T;
}

const [packageDir, mode, scenarioName, keptFolder] = process.argv.slice(2);
if (!packageDir || (mode !== "pi" && mode !== "hosted") || !scenarioName) {
	throw new Error(
		"usage: hosted-session.mts <package dir> <pi|hosted> <scenario> [folder]",
	);
}

const pi = await loadHostPi(packageDir);
const load = async (file: string): Promise<unknown> =>
	import(pathToFileURL(join(packageDir, file)).href);
const compat = piModule<Compat>(
	await load("node_modules/@earendil-works/pi-ai/dist/compat.js"),
);
const { AuthStorage } = piModule<Auth>(await load("dist/core/auth-storage.js"));
const coding = piModule<Coding>(pi.modules.codingAgent);

interface Scenario {
	responses: () => unknown[];
	/** How fast the provider streams, for a scenario that acts mid-stream. */
	tokensPerSecond?: number;
	tools?: (session: () => Session) => unknown[];
	drive: (session: Session) => Promise<void>;
	/** What the session is sent before the agent recovers, as an extension's start may send it. */
	early?: (session: Session) => Promise<void>;
	/** Keep the session in a file under the folder, to be opened again by a later run. */
	persist?: boolean;
	/** Settings over the fixture's, which turn pi's retry and compaction off. */
	settings?: object;
	/** The scripted provider's models, when one will not do. */
	models?: readonly object[];
	/** The model the session selects, given the runtime and the scripted provider's id; its first model, otherwise. */
	select?: (runtime: ModelRuntime, provider: string) => unknown;
}

/** Two models of different sizes, for a scenario that tells which answered. */
const SMALL_AND_LARGE = [
	{ id: "faux-small", contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "faux-large", contextWindow: 128_000, maxTokens: 16_384 },
];

/** Where a tool notes each time it really runs, so a rerun shows. */
const effects = (): string => join(folder, "effects");
const noteEffect = (text: string): void =>
	appendFileSync(effects(), `${text}\n`);

/** How long an answer waits for the early prompt to return before it answers anyway. */
const EARLY_WAIT_MS = 3_000;
let earlyReturned = () => {};
/** Settles once the scenario's early prompt returned, so an answer can wait on it. */
const returned = new Promise<void>((done) => {
	earlyReturned = done;
});

const say = (text: string) => compat.fauxAssistantMessage(text);
const call = (id: string, text: string, timestamp?: number) =>
	compat.fauxAssistantMessage([compat.fauxToolCall("echo", { text }, { id })], {
		stopReason: "toolUse",
		...(timestamp === undefined ? {} : { timestamp }),
	});

/** A tool that echoes its text, after doing whatever the scenario asks of the session meanwhile. */
function echo(
	during?: (session: Session, signal: AbortSignal | undefined) => Promise<void>,
) {
	return (session: () => Session) => [
		{
			name: "echo",
			label: "echo",
			description: "Echo the text back",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			async execute(
				_id: string,
				params: { text: string },
				signal?: AbortSignal,
			) {
				await during?.(session(), signal);
				return {
					content: [{ type: "text", text: `echo: ${params.text}` }],
					details: { echoed: params.text },
				};
			},
		},
	];
}

const scenarios: Record<string, Scenario> = {
	plain: {
		responses: () => [say("hello there")],
		drive: (session) => session.prompt("hi"),
	},
	tool: {
		responses: () => [call("call-1", "ping"), say("done")],
		tools: echo(),
		drive: (session) => session.prompt("use the tool"),
	},
	steer: {
		responses: () => [call("call-1", "ping"), say("steered")],
		tools: echo(async (session) => {
			await session.steer("also consider this");
		}),
		drive: (session) => session.prompt("use the tool"),
	},
	"follow-up": {
		responses: () => [call("call-1", "ping"), say("done"), say("followed up")],
		tools: echo(async (session) => {
			await session.followUp("and then this");
		}),
		drive: (session) => session.prompt("use the tool"),
	},
	error: {
		responses: () => [
			compat.fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "provider fell over",
			}),
		],
		drive: (session) => session.prompt("hi"),
	},
	"abort-in-tool": {
		responses: () => [call("call-1", "ping"), say("never")],
		tools: echo(async (session, signal) => {
			const aborted = new Promise<void>((resolve) =>
				signal?.addEventListener("abort", () => resolve()),
			);
			void session.abort();
			await aborted;
		}),
		drive: (session) => session.prompt("use the tool"),
	},
	"crash-in-tool": {
		responses: () => [call("call-1", "ping"), say("never")],
		tools: echo(async () => {
			noteEffect("ping");
			process.kill(process.pid, "SIGKILL");
		}),
		drive: (session) => session.prompt("use the tool"),
		persist: true,
	},
	/** Die as the tool round's turn ends: pi showed the answer and its result, durable never heard what follows. */
	"crash-at-turn-end": {
		responses: () => [call("call-1", "ping"), say("never")],
		tools: echo(async () => noteEffect("ping")),
		drive: async (session) => {
			session.agent.subscribe((event) => {
				if (event.type === "turn_end") process.kill(process.pid, "SIGKILL");
			});
			await session.prompt("use the tool");
		},
		persist: true,
	},
	/** Die in the second round's tool, the first round's done. */
	"crash-in-second-tool": {
		responses: () => [
			call("call-1", "ping"),
			// Made at once, the answers would share a time, and so pi's key for them.
			call("call-2", "pong", Date.now() + 1),
			say("never"),
		],
		tools: echo(async () => {
			noteEffect("ran");
			if (readFileSync(effects(), "utf8").split("\n").length > 2)
				process.kill(process.pid, "SIGKILL");
		}),
		drive: (session) => session.prompt("use the tool"),
		persist: true,
	},
	reopen: {
		responses: () => [say("after the restart")],
		tools: echo(async () => noteEffect("ping")),
		drive: async () => {},
		persist: true,
	},
	/** Reopen with a prompt sent before the recovery, as an extension starting with the session sends one. */
	"reopen-prompted": {
		responses: () => [
			// The carried-on turn answers once the prompt returned, so the events show whether it waited for that turn.
			async () => {
				await Promise.race([
					returned,
					// A prompt that waits for the turn returns only after it: the answer stops waiting.
					new Promise((done) => setTimeout(done, EARLY_WAIT_MS)),
				]);
				return say("after the restart");
			},
			say("and the prompt"),
		],
		tools: echo(async () => noteEffect("ping")),
		early: (session) => session.prompt("sent at the start"),
		drive: async () => {},
		persist: true,
	},
	/** Open the kept session file as it stands, sending nothing. */
	inspect: {
		responses: () => [],
		tools: echo(),
		drive: async () => {},
		persist: true,
	},
	"two-prompts": {
		responses: () => [call("call-1", "ping"), say("first"), say("second")],
		tools: echo(),
		drive: async (session) => {
			await session.prompt("use the tool");
			await session.prompt("and again");
		},
	},
	"unknown-tool": {
		responses: () => [
			compat.fauxAssistantMessage(
				[
					compat.fauxToolCall("missing", { text: "x" }, { id: "call-1" }),
					compat.fauxToolCall("echo", { text: "ping" }, { id: "call-2" }),
					compat.fauxToolCall("echo", { wrong: 1 }, { id: "call-3" }),
				],
				{ stopReason: "toolUse" },
			),
			say("done"),
		],
		tools: echo(),
		drive: (session) => session.prompt("use the tools"),
	},
	"abort-in-stream": {
		responses: () => [
			say(
				"a long answer that streams slowly enough to be cut off part way through",
			),
		],
		tokensPerSecond: 200,
		drive: async (session) => {
			let updates = 0;
			session.agent.subscribe((event) => {
				if (event.type === "message_update" && ++updates === 2)
					void session.abort();
			});
			await session.prompt("hi");
		},
	},
	/** A virtual model whose router sends the user's turn to one model and the tool round's continuation to another. */
	routed: {
		responses: () => [call("call-1", "ping"), say("done")],
		tools: echo(),
		models: SMALL_AND_LARGE,
		select: (runtime, provider) => {
			runtime.registerVirtualModel({
				provider: "router",
				id: "auto",
				name: "Auto",
				route: (request) => ({
					model: runtime.getModel(
						provider,
						request.reason === "user" ? "faux-small" : "faux-large",
					),
					thinkingLevel: "off",
				}),
			});
			const routed = runtime.getModel("router", "auto");
			if (!routed) throw new Error("pi lists no virtual model router/auto");
			return routed;
		},
		drive: (session) => session.prompt("use the tool"),
	},
	/** A provider error pi retries, by continuing the run. */
	retry: {
		responses: () => [
			compat.fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "503 Service Unavailable: overloaded",
			}),
			say("recovered"),
		],
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		drive: (session) => session.prompt("hi"),
	},
	/** A context overflow pi recovers from by compacting, then continuing. */
	overflow: {
		responses: () => [
			say("one"),
			compat.fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "prompt is too long: 200000 tokens > 128000 maximum",
			}),
			say("the conversation so far, summarised"),
			// Keeping one token cuts through the turn, so pi summarises the turn's start as well.
			say("the turn so far, summarised"),
			say("after compacting"),
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		drive: async (session) => {
			await session.prompt("first");
			await session.prompt("second");
		},
	},
	/** Go back to the first answer and carry on from there, leaving the second on its own branch. */
	branch: {
		responses: () => [say("one"), say("two"), say("three")],
		drive: async (session) => {
			await session.prompt("first");
			await session.prompt("second");
			const firstAnswer = session.sessionManager
				.getEntries()
				.find((entry) => entry.message?.role === "assistant");
			if (!firstAnswer) throw new Error("no first answer to go back to");
			await session.navigateTree(firstAnswer.id, { summarize: false });
			await session.prompt("third");
		},
	},
	truncated: {
		responses: () => [
			compat.fauxAssistantMessage(
				[compat.fauxToolCall("echo", { text: "pi" }, { id: "call-1" })],
				{
					stopReason: "length",
				},
			),
			say("recovered"),
		],
		tools: echo(),
		drive: (session) => session.prompt("use the tool"),
	},
};

const scenario = scenarios[scenarioName];
if (!scenario) throw new Error(`no scenario ${scenarioName}`);

const folder = keptFolder ?? mkdtempSync(join(tmpdir(), "hosted-session-"));
const sessionDir = join(folder, "sessions");
// A fixed chunk size, so both runs stream the same deltas.
const faux = compat.registerFauxProvider({
	tokenSize: { min: 2, max: 2 },
	...(scenario.tokensPerSecond
		? { tokensPerSecond: scenario.tokensPerSecond }
		: {}),
	...(scenario.models ? { models: scenario.models } : {}),
});
try {
	faux.setResponses(scenario.responses());
	const model = faux.getModel();
	const storage = AuthStorage.inMemory();
	await storage.modify(model.provider, async () => ({
		type: "api_key",
		key: "faux-key",
	}));
	const modelRuntime = await coding.ModelRuntime.create({
		credentials: storage,
		modelsPath: join(folder, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: faux.models.map((each) => ({
			id: each.id,
			name: each.name,
			api: each.api,
			reasoning: each.reasoning,
			input: each.input,
			cost: each.cost,
			contextWindow: each.contextWindow,
			maxTokens: each.maxTokens,
			baseUrl: each.baseUrl,
		})),
	});
	const selected = scenario.select?.(modelRuntime, model.provider) ?? model;
	const conversation =
		mode === "hosted"
			? await openHostedConversation({
					modules: pi.modules,
					library: piLibrary(pi.modules),
					storePath: join(folder, "durable", "store.sqlite"),
					env: async () => ({}),
					report: (error) =>
						process.stderr.write(`durable reported: ${String(error)}\n`),
				})
			: undefined;
	let built: Session | undefined;
	const { session } = await coding.createAgentSession({
		cwd: folder,
		agentDir: join(folder, "agent"),
		sessionManager: scenario.persist
			? persisted()
			: coding.SessionManager.inMemory(folder),
		settingsManager: coding.SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			...scenario.settings,
		}),
		modelRuntime,
		model: selected,
		noTools: "builtin",
		customTools:
			scenario.tools?.(() => {
				if (!built) throw new Error("the session is not built yet");
				return built;
			}) ?? [],
		...(conversation ? { createAgent: conversation.createAgent } : {}),
	});
	built = session;
	const events: unknown[] = [];
	session.agent.subscribe((event: unknown) => {
		events.push(comparable(event));
	});
	const reached = new Promise<void>((resolve) => {
		const stop = session.agent.subscribe(() => {
			stop();
			resolve();
		});
	});
	const early = scenario.early?.(session).then(() => {
		events.push({ type: "early_returned" });
		earlyReturned();
	});
	// The early run has reached the agent, as it had on 13 November.
	if (early) await Promise.race([reached, early]);
	const recovery = await conversation?.agent?.recover();
	await recovery?.settled;
	await early;
	await scenario.drive(session);
	await session.agent.waitForIdle();
	const transcript = session.agent.state.messages.map(comparable);
	session.dispose();
	await conversation?.close();
	const ran = existsSync(effects())
		? readFileSync(effects(), "utf8").split("\n").filter(Boolean).length
		: 0;
	process.stdout.write(
		`${JSON.stringify({ events, transcript, ...(scenario.persist ? { ran } : {}) })}\n`,
	);
} finally {
	faux.unregister();
	if (!keptFolder) rmSync(folder, { recursive: true, force: true });
}

/** The session file under the folder, opened if a run before left one. */
function persisted(): unknown {
	const files = existsSync(sessionDir)
		? readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"))
		: [];
	const [file] = files;
	return file
		? coding.SessionManager.open(join(sessionDir, file), sessionDir)
		: coding.SessionManager.create(folder, sessionDir);
}

/** An event or message without what differs between two runs of one script. */
function comparable(value: unknown): unknown {
	const text = JSON.stringify(value, (key, field) => {
		if (key === "timestamp" || key === "durationMs" || key === "responseId")
			return undefined;
		if (key === "api" && typeof field === "string" && field.startsWith("faux:"))
			return "faux";
		return field;
	});
	return JSON.parse(
		text.replaceAll(folder, "<folder>").replace(/faux:\d+:[a-z0-9]+/g, "faux"),
	);
}
