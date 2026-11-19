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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createOutbox,
	type Outbox,
	STEERED_RESULTS,
} from "../../../../extensions/job-workflow/outbox.ts";
import { holdMessagesThroughCarriedTurns } from "../../../../host/engine/carried-turn-messages.ts";
import { loadHostPi } from "../../../../host/engine/host-pi.ts";
import type { HostedAgent } from "../../../../host/engine/hosted-agent.ts";
import { openHostedConversation } from "../../../../host/engine/hosted-conversation.ts";
import { piLibrary } from "../../../../host/engine/pi-library.ts";
import {
	callSignal,
	withCallSignal,
} from "../../../../lib/core/exec/call-signal.ts";
import { isRecord } from "../../../../lib/internal/record.ts";

/** What the fixture drives of a pi session. */
interface Session {
	prompt(
		text: string,
		options?: {
			streamingBehavior?: "steer" | "followUp";
			preflightResult?: (disposition: "handled" | "queued" | "started") => void;
		},
	): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
	): Promise<void>;
	/** No run and no compaction, by pi's own account. */
	readonly isIdle: boolean;
	abort(): Promise<void>;
	dispose(): void;
	/** The agent-interface patch's, where the runtime has it. */
	showQueued?(text: string, mode: "steer" | "followUp"): void;
	/** The words pi's screen lists as pending behind the turn. */
	getFollowUpMessages(): readonly string[];
	navigateTree(targetId: string, options: object): Promise<unknown>;
	readonly isStreaming: boolean;
	readonly extensionRunner: {
		emit(event: {
			readonly type: "agent_settled";
			readonly aborted: boolean;
		}): Promise<unknown>;
	};
	subscribe(listener: (event: { readonly type: string }) => void): () => void;
	readonly sessionManager: {
		appendCustomMessageEntry(
			customType: string,
			content: string,
			display: boolean,
		): string;
		getEntries(): readonly {
			readonly id: string;
			readonly type: string;
			readonly message?: { readonly role: string };
		}[];
	};
	readonly agent: {
		subscribe(listener: (event: { readonly type: string }) => void): () => void;
		waitForIdle(): Promise<void>;
		hasQueuedMessages(): boolean;
		continue(): Promise<void>;
		steer(message: unknown): void;
		followUp(message: unknown): void;
		readonly state: {
			readonly messages: unknown[];
			readonly isStreaming: boolean;
		};
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
	readonly DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
		extensionFactories: readonly ((pi: ExtensionPi) => void)[];
	}) => { reload(): Promise<void> };
}

/** What the fixture's extension uses of pi's extension API. */
interface ExtensionPi {
	on(
		event:
			| "agent_start"
			| "agent_settled"
			| "message_end"
			| "before_agent_start",
		handler: (event: Record<string, unknown>) => void | Promise<void>,
	): void;
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
	/** What the session is sent once the recovery has begun carrying a turn on, as an extension may send it then. */
	during?: (session: Session, agent?: HostedAgent) => Promise<void>;
	/** Keep the session in a file under the folder, to be opened again by a later run. */
	persist?: boolean;
	/** Recover as a start's resume does, noting each turn the run takes and gives back. */
	turns?: boolean;
	/** Words Joel types while the carried run waits for its turn, which comes once the agent has them. */
	typed?: string;
	/** Settings over the fixture's, which turn pi's retry and compaction off. */
	settings?: object;
	/** The scripted provider's models, when one will not do. */
	models?: readonly object[];
	/** The model the session selects, given the runtime and the scripted provider's id; its first model, otherwise. */
	select?: (runtime: ModelRuntime, provider: string) => unknown;
	/**
	 * Load an extension that tells job-workflow's outbox what the session
	 * does, as job-workflow's extension does, and notes each agent_settled
	 * the extensions hear.
	 */
	listens?: boolean;
	/**
	 * Load an extension that adds a section to every run pi prepares, as
	 * the harness's resident block and standing context do, noting each
	 * run it prepares.
	 */
	sections?: boolean;
	/**
	 * Load an extension slow to prepare a run the host carries on, as a
	 * handler waiting on a slow service would be, noting when it begins.
	 */
	stalls?: boolean;
	/**
	 * Load an extension that kills the host as pi begins settling a run,
	 * writing first what the scenario typed, since the run never prints.
	 */
	diesAtSettle?: boolean;
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

/** How long an answer waits for the agent to hold queued words before it answers anyway. */
const QUEUED_WAIT_MS = 3_000;
/** How often that answer looks again. */
const QUEUED_POLL_MS = 20;
/** How long an outbox scenario waits for its result to be seen. */
const OUTBOX_WAIT_MS = 10_000;
/** How often it looks. */
const OUTBOX_POLL_MS = 50;
/** A background command's result, as job-workflow says one. */
const JOB_RESULT = {
	jobId: "j1",
	label: "background command j1",
	text: "soak job done",
};
/** The outbox the fixture's extension keeps, and how many prompts it sent, once pi loaded it. */
let listened: { readonly box: Outbox; sends(): number } | undefined;
/** How long a slow provider takes to its first token, deaf to an abort meanwhile. */
const SLOW_FIRST_TOKEN_MS = 30_000;
/** Resolve askedOnce, once the slow provider is asked. */
let asked = (): void => {};
/** Settles once the slow provider is asked for an answer. */
const askedOnce = new Promise<void>((done) => {
	asked = done;
});
/** How long the stalling extension takes to prepare a carried run: twice what a parked close may take. */
const STALL_MS = 10_000;
/** How long pi may take to begin preparing a carried run before the case says it never did. */
const PREPARING_BEGINS_MOST_MS = 10_000;
/** Resolve preparing, once the stalling extension begins preparing a carried run. */
let preparingBegan = (): void => {};
/** Settles once the stalling extension begins preparing a carried run. */
const preparing = new Promise<void>((done) => {
	preparingBegan = done;
});
/** Words typed the moment pi sees a carried run end, before pi settles it. */
const TYPED_AS_IT_ENDS = "typed as it ended";
/** Where the scenario typing them says what it saw, since it dies before printing; carried-runs.test.ts reads it. */
const TYPED_AS_IT_ENDS_FILE = "typed-as-it-ends.json";
/** The words reopen-typed-as-it-ends steers with as the carried run ends. */
const STEERED_AS_IT_ENDS = "steered as it ended";
/** How long that scenario waits to see the carried run end. */
const CARRIED_END_WAIT_MS = 20_000;
/** What that scenario saw as it typed, written as the host dies. */
let typedAsItEnds: object = { typed: false };
/** What the session's agent holds queued, once the session is built. */
let queued = (): boolean => false;
/** The words pi's screen lists as pending, once the session is built. */
let pending = (): readonly string[] => [];
/** Note an event among those pi's listeners saw, once the session is built. */
let note = (_event: {
	readonly type: string;
	readonly pending?: readonly string[];
	readonly error?: string;
	readonly sends?: number;
	readonly waiting?: number;
	readonly ms?: number;
	readonly first?: boolean;
	/**
	 * Whether a run was under way at the event: the agent's, once a step
	 * returned, or pi's, as words were sent.
	 */
	readonly streaming?: boolean;
	/** The signal a command started now would stop with: none, one still live, or one already aborted. */
	readonly signal?: "none" | "live" | "aborted";
	readonly trigger?: unknown;
	readonly sectioned?: boolean;
	readonly prompt?: string;
	readonly paired?: boolean;
}): void => {};

/** Answer only after SLOW_FIRST_TOKEN_MS, as a provider that pays an abort no heed does. */
async function answerSlowly(): Promise<unknown> {
	asked();
	await new Promise((done) => setTimeout(done, SLOW_FIRST_TOKEN_MS));
	return say("too late");
}

/** Answer `text` once the agent holds queued words, noting that it did, or after a while. */
async function answerOnceQueued(text: string): Promise<unknown> {
	const by = Date.now() + QUEUED_WAIT_MS;
	while (!queued() && Date.now() < by) {
		// Polled: nothing tells a listener that words were queued.
		await new Promise((done) => setTimeout(done, QUEUED_POLL_MS));
	}
	if (queued()) note({ type: "queued_mid_turn", pending: [...pending()] });
	return say(text);
}

const say = (text: string) => compat.fauxAssistantMessage(text);

/** Words a person queued after an answer. */
function alsoThis(): unknown {
	return {
		role: "user",
		content: [{ type: "text", text: "also this" }],
		timestamp: Date.now(),
	};
}

/** Continue the session's agent, saying what it threw, or "none". */
function continuedWith(session: Session): Promise<string> {
	return session.agent.continue().then(
		() => "none",
		(refused: unknown) =>
			refused instanceof Error ? refused.message : String(refused),
	);
}

/** The section the fixture's sectioning extension adds to every run pi prepares. */
const SECTION = "Kept for every run of this conversation.";

/** The name the fixture's sectioning extension gives its section. */
const SECTION_NAME = "host-carried-run";

/**
 * The sections in force at a request's end: its system messages folded in
 * order, each replacing sections by name and a null removing one, as pi's
 * transcript says they do.
 */
function sectionsInForce(messages: readonly unknown[]): Record<string, string> {
	const sections: Record<string, string> = {};
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "system") continue;
		if (!isRecord(message.sections)) continue;
		for (const [name, value] of Object.entries(message.sections)) {
			if (typeof value === "string") sections[name] = value;
			else delete sections[name];
		}
	}
	return sections;
}

/**
 * Answer `text`, noting the sections the request carried, whether the
 * extension's is among them, and whether pi's prepared messages left each
 * tool result after its call.
 */
function sectionedAnswer(text: string) {
	return (context: { readonly messages: readonly unknown[] }): unknown => {
		const sections = sectionsInForce(context.messages);
		note({
			type: "request",
			sectioned: (sections[SECTION_NAME] ?? "").includes(SECTION),
			prompt: JSON.stringify(sections),
			paired: firstUnpaired(context.messages) === undefined,
		});
		return say(text);
	};
}

/**
 * Answer `text`, unless a tool result in the request does not follow its
 * call's answer, which is refused as Anthropic's API refuses it.
 */
function pairedOrRefused(text: string) {
	return (context: { readonly messages: readonly unknown[] }): unknown => {
		const at = firstUnpaired(context.messages);
		return at === undefined
			? say(text)
			: compat.fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: `400 messages.${at}: unexpected tool_use_id found in tool_result blocks`,
				});
	};
}

/** Where the first tool result whose call is not in the answer just before the results stands. */
function firstUnpaired(messages: readonly unknown[]): number | undefined {
	const roleAt = (index: number): unknown => {
		const message = messages[index];
		return isRecord(message) ? message.role : undefined;
	};
	for (const [index, message] of messages.entries()) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		let before = index - 1;
		while (before >= 0 && roleAt(before) === "toolResult") before--;
		const answer = messages[before];
		const calls =
			isRecord(answer) &&
			answer.role === "assistant" &&
			Array.isArray(answer.content) &&
			answer.content.some(
				(part: unknown) => isRecord(part) && part.id === message.toolCallId,
			);
		if (!calls) return index;
	}
	return undefined;
}
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

/** The prompt a call left to say its result once the session is idle, once the call made it. */
let leftToSay: Promise<void> | undefined;

/** Prompt with `text` once the session is idle, as a job a call handed off says its result. */
async function sayOnceIdle(session: Session, text: string): Promise<void> {
	while (!session.isIdle)
		await new Promise((done) => setTimeout(done, QUEUED_POLL_MS));
	await session.prompt(text);
}

/**
 * Two calls in two runs. The first runs under its own call's signal, as a
 * review tool does, and leaves work that says a result once the session
 * is idle, as a council handed off to the background does; the run that
 * result starts makes the second call, which notes the call signal a
 * command it started would stop with. pi's own agent carries the first
 * call's signal into that run as well, live since pi never aborts it; the
 * host's must carry none, since durable aborts it as the call ends.
 */
function signalledThenPlain() {
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
				if (params.text === "signalled")
					withCallSignal(signal, () => {
						leftToSay = sayOnceIdle(session(), "the job's result");
					});
				else {
					const left = callSignal();
					note({
						type: "call signal",
						signal: !left ? "none" : left.aborted ? "aborted" : "live",
					});
				}
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
	"call-signal": {
		responses: () => [
			call("call-1", "signalled"),
			say("handed off"),
			call("call-2", "plain"),
			say("done"),
		],
		tools: signalledThenPlain(),
		drive: async (session) => {
			await session.prompt("use the tool");
			await leftToSay;
		},
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
	/** Die as the model is asked, before any answer: durable holds the request in flight, as a reboot left one on 14 November. */
	"crash-in-request": {
		responses: () => [
			() => {
				process.kill(process.pid, "SIGKILL");
				return say("never");
			},
		],
		drive: (session) => session.prompt("hi"),
		persist: true,
	},
	/** As crash-in-request, the turn begun by words the harness said rather than a person. */
	"crash-in-request-automated": {
		responses: () => [
			() => {
				process.kill(process.pid, "SIGKILL");
				return say("never");
			},
		],
		drive: (session) =>
			session.prompt(
				"[Automated message, no human input: background jobs are reporting.] done",
			),
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
	/** Reopen as a start's resume does, its carried run taking a turn. */
	"reopen-taking-turns": {
		responses: () => [say("after the restart")],
		tools: echo(async () => noteEffect("ping")),
		drive: async () => {},
		persist: true,
		turns: true,
	},
	/** As reopen-taking-turns, the carried run going on past its first answer with another tool round, as a builder's does. */
	"reopen-taking-turns-busy": {
		responses: () => [
			call("call-2", "pong", Date.now() + 1),
			say("after the restart"),
		],
		tools: echo(async () => noteEffect("pong")),
		drive: async () => {},
		persist: true,
		turns: true,
	},
	/** As reopen-taking-turns, a background job's result coming once the carried run ended, as soak conversations' did on 15 November. */
	"reopen-job-reports-after": {
		responses: () => [say("after the restart"), say("and the job's result")],
		tools: echo(async () => noteEffect("ping")),
		drive: (session) => reportThroughTheExtension(session, JOB_RESULT),
		persist: true,
		turns: true,
		listens: true,
	},
	/** As reopen-taking-turns, Joel typing into the conversation while its carried run waits for a turn. */
	"reopen-typed-while-waiting": {
		responses: () => [say("after the restart"), say("and your words")],
		drive: async () => {},
		persist: true,
		turns: true,
		typed: "are you back?",
	},
	/** As reopen, with an extension adding a section to each run, and words typed once the carried run ends. */
	"reopen-sectioned": {
		responses: () => [
			sectionedAnswer("after the restart"),
			sectionedAnswer("and your words"),
		],
		tools: echo(async () => noteEffect("ping")),
		drive: (session) => session.prompt("typed once it was back"),
		persist: true,
		sections: true,
	},
	/** A fresh conversation recovering as a start's resume does: nothing carried, so no turn. */
	"fresh-taking-turns": {
		responses: () => [say("hello")],
		drive: (session) => session.prompt("hi"),
		turns: true,
	},
	/** Reopen with a prompt sent before the recovery, as an extension starting with the session sends one. */
	"reopen-prompted": {
		responses: () => [
			// The carried-on turn answers once the prompt's words are queued, so the events show whether they were.
			() => answerOnceQueued("after the restart"),
			say("and the prompt"),
		],
		tools: echo(async () => noteEffect("ping")),
		early: (session) => session.prompt("sent at the start"),
		drive: async () => {},
		persist: true,
	},
	/** Reopen with a prompt sent while the recovery carries the cut-off turn on, queued as pi's editor queues words typed into a run under way. */
	"reopen-prompted-during": {
		responses: () => [
			() => answerOnceQueued("after the restart"),
			say("and the prompt"),
		],
		tools: echo(async () => noteEffect("ping")),
		during: async (session, agent) => {
			const by = Date.now() + QUEUED_WAIT_MS;
			while (!session.isStreaming && Date.now() < by) {
				// Polled: typed once the carried turn shows as pi's run under way.
				await new Promise((done) => setTimeout(done, QUEUED_POLL_MS));
			}
			note({ type: "prompted", streaming: session.isStreaming });
			// As an open waits for its first words: held once durable has them, which commits no prompt here.
			const watch = agent?.watchWords();
			void watch?.held.then(
				() => note({ type: "words_held" }),
				(error: unknown) =>
					note({ type: "words_refused", error: String(error) }),
			);
			try {
				// The carried turn is pi's own run, so pi refuses words that
				// don't say how to wait, as it does in any run; its editor
				// sends them as a follow-up.
				await session.prompt("sent during the turn", {
					streamingBehavior: session.isStreaming ? "followUp" : undefined,
					// As an open tells its watch what pi did with its first words.
					preflightResult: (disposition) => watch?.told(disposition),
				});
			} catch (error) {
				// Noted rather than thrown, so the test sees what pi's caller was told.
				note({ type: "prompt_refused", error: String(error) });
			}
		},
		drive: async () => {},
		persist: true,
	},
	/** As reopen-prompted-during, the cut-off notice said through job-workflow's outbox, which says again what a run did not carry. */
	"reopen-noticed-during": {
		responses: () => [
			() => answerOnceQueued("after the restart"),
			say("and the notice"),
		],
		tools: echo(async () => noteEffect("ping")),
		during: (session) =>
			sayThroughAnOutbox(session, {
				jobId: "cut-off",
				label: "the machine ended this session",
				text: "a restart cut the turn off",
			}),
		drive: async () => {},
		persist: true,
	},
	/** Reopen into a tool round whose tool hears a peer's word, as a mesh message reached a turn durable carried on on 13 November. */
	"reopen-with-a-word": {
		responses: () => [
			call("call-2", "pong"),
			pairedOrRefused("after the word"),
		],
		tools: echo(async (session) => {
			await session.sendCustomMessage(
				{ customType: "mesh", content: "a word from a peer", display: true },
				{ triggerTurn: false },
			);
		}),
		drive: async () => {},
		persist: true,
	},
	/** As reopen-with-a-word, the host stopping as the tool's word is held, its turn never ending. */
	"reopen-with-a-word-stopped": {
		responses: () => [call("call-2", "pong"), say("never")],
		tools: echo(async (session) => {
			await session.sendCustomMessage(
				{ customType: "mesh", content: "a word from a peer", display: true },
				{ triggerTurn: false },
			);
			stopHost();
		}),
		drive: async () => {},
		persist: true,
	},
	/** As reopen-with-a-word, the word written straight into the file between the call and its result, as pi wrote it on 13 November. */
	"reopen-with-a-word-written": {
		responses: () => [
			call("call-2", "pong"),
			pairedOrRefused("after the word"),
		],
		tools: echo(async (session) => {
			session.sessionManager.appendCustomMessageEntry(
				"mesh",
				"a word from a peer",
				true,
			);
		}),
		drive: async () => {},
		persist: true,
	},
	/** Open the kept session again and prompt it, its file as the last run left it. */
	"reopen-asked": {
		responses: () => [pairedOrRefused("answered")],
		tools: echo(),
		drive: (session) => session.prompt("and now?"),
		persist: true,
	},
	/** Open the kept session file as it stands, sending nothing. */
	inspect: {
		responses: () => [],
		tools: echo(),
		drive: async () => {},
		persist: true,
	},
	/** Answer a prompt, then say a background job's result through the extension's outbox once the run settled. */
	"job-result": {
		responses: () => [say("hello"), say("and the job's result")],
		drive: async (session) => {
			await session.prompt("hi");
			await reportThroughTheExtension(session, JOB_RESULT);
		},
		listens: true,
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
	/**
	 * pi's continue once durable's session has closed under it, words still
	 * waiting: durable refuses every admission at once, and pi's loop asks
	 * again for as long as a continue only resolves (18 November).
	 */
	"continue-closed": {
		responses: () => [say("one")],
		drive: async (session) => {
			await session.prompt("hi");
			await closeStore();
			session.agent.state.messages.push({
				role: "user",
				content: [{ type: "text", text: "again" }],
				timestamp: Date.now(),
			});
			const error = await continuedWith(session);
			note({
				type: "continued",
				error,
				streaming: session.agent.state.isStreaming,
			});
		},
	},
	/** As continue-closed, but with words pi queued to steer after the answer, which continue runs as a prompt. */
	"continue-closed-steered": {
		responses: () => [say("one")],
		drive: async (session) => {
			await session.prompt("hi");
			await closeStore();
			session.agent.steer(alsoThis());
			const error = await continuedWith(session);
			note({
				type: "continued",
				error,
				streaming: session.agent.state.isStreaming,
			});
		},
	},
	/** As continue-closed-steered, but queued as a follow-up. */
	"continue-closed-followed": {
		responses: () => [say("one")],
		drive: async (session) => {
			await session.prompt("hi");
			await closeStore();
			session.agent.followUp(alsoThis());
			const error = await continuedWith(session);
			note({
				type: "continued",
				error,
				streaming: session.agent.state.isStreaming,
			});
		},
	},
	/** As reopen, the host stopping while an extension is slow to prepare the carried run. */
	"reopen-park-preparing": {
		responses: () => [say("after the restart")],
		tools: echo(async () => noteEffect("ping")),
		during: async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const began = await Promise.race([
				preparing.then(() => true),
				new Promise<boolean>((done) => {
					// A bound, so a runtime whose pi never prepares the run fails the case in seconds rather than at vitest's timeout.
					timer = setTimeout(() => done(false), PREPARING_BEGINS_MOST_MS);
				}),
			]);
			clearTimeout(timer);
			if (!began) note({ type: "never prepared" });
			note({ type: "parking" });
			await parkAndClose();
		},
		drive: async () => {},
		persist: true,
		stalls: true,
	},
	/**
	 * As reopen, Joel's words reaching the agent the moment pi sees the
	 * carried run end, once durable has gone idle, and the host dying as pi
	 * begins settling the run: what it saw is written to a file, since it
	 * never prints.
	 */
	"reopen-typed-as-it-ends": {
		responses: () => [
			say("after the restart"),
			say("and your words"),
			say("and your steer"),
		],
		// Slow enough that the carried run is still under way once the recovery has begun.
		tokensPerSecond: 20,
		tools: echo(async () => noteEffect("ping")),
		during: async (session) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let stop = () => {};
			const ended = await new Promise<boolean>((done) => {
				stop = session.agent.subscribe((event: unknown) => {
					if (!isRecord(event) || event.type !== "agent_end") return;
					stop();
					clearTimeout(timer);
					// Queued as pi's prompt queues words typed into a run under way, at a moment
					// of the run's own rather than after pi's input handlers, which take a while:
					// a follow-up, and a steer, as Enter during a run sends.
					session.agent.followUp({
						role: "user",
						content: [{ type: "text", text: TYPED_AS_IT_ENDS }],
						timestamp: Date.now(),
					});
					session.agent.steer({
						role: "user",
						content: [{ type: "text", text: STEERED_AS_IT_ENDS }],
						timestamp: Date.now(),
					});
					typedAsItEnds = {
						typed: true,
						streaming: session.isStreaming,
						queuedOnceTyped: queued(),
					};
					done(true);
				});
				// A bound, so a carried run that never ends fails the case in seconds rather than at vitest's timeout;
				// it stops listening, so a late end can't overwrite what it saw.
				timer = setTimeout(() => {
					stop();
					done(false);
				}, CARRIED_END_WAIT_MS);
			});
			typedAsItEnds = { ...typedAsItEnds, ended };
		},
		drive: async () => {},
		persist: true,
		diesAtSettle: true,
	},
	/** Open the kept session again after reopen-typed-as-it-ends, answering any words it kept. */
	"reopen-after-typed": {
		responses: () => [say("and your words")],
		drive: async () => {},
		persist: true,
	},
	/** A host stopping before the provider's first token, the provider paying the park's abort no heed. */
	"park-slow-first-token": {
		responses: () => [answerSlowly],
		drive: async (session) => {
			void session.prompt("hi").catch(() => {
				// The park ends this prompt; how long the close takes is what is seen.
			});
			await askedOnce;
			await parkAndClose();
		},
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

/** Stop the host mid-round, once the session is built. */
let stopHost: () => void = () => {
	throw new Error("the session is not built yet");
};

/** Close durable's store under the session, as a parked or failed conversation's closes; once the session is built. */
let closeStore: () => Promise<void> = async () => {
	throw new Error("the session is not built yet");
};

/** Park and close as a stopping host does, noting how long the close took, then end; once the session is built. */
let parkAndClose: () => Promise<void> = async () => {
	throw new Error("the session is not built yet");
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
	const builtSession = (): Session => {
		if (!built) throw new Error("the session is not built yet");
		return built;
	};
	const agentDir = join(folder, "agent");
	const settingsManager = coding.SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
		...scenario.settings,
	});
	// pi's own loader, as createAgentSession builds it, with the fixture's extension beside.
	const extensionFactories = [
		...(scenario.listens ? [listeningExtension(builtSession)] : []),
		...(scenario.sections ? [sectioningExtension] : []),
		...(scenario.stalls ? [stallingExtension] : []),
		...(scenario.diesAtSettle ? [settleKillingExtension] : []),
	];
	const resourceLoader =
		extensionFactories.length > 0
			? new coding.DefaultResourceLoader({
					cwd: folder,
					agentDir,
					settingsManager,
					extensionFactories,
				})
			: undefined;
	await resourceLoader?.reload();
	const { session } = await coding.createAgentSession({
		cwd: folder,
		agentDir,
		sessionManager: scenario.persist
			? persisted()
			: coding.SessionManager.inMemory(folder),
		settingsManager,
		...(resourceLoader ? { resourceLoader } : {}),
		modelRuntime,
		model: selected,
		noTools: "builtin",
		customTools: scenario.tools?.(builtSession) ?? [],
		...(conversation ? { createAgent: conversation.createAgent } : {}),
	});
	built = session;
	// As the host's engine does for each session it builds.
	if (conversation?.agent) {
		holdMessagesThroughCarriedTurns(session, conversation.agent, (error) =>
			process.stderr.write(`held message reported: ${String(error)}\n`),
		);
		// Among the events, which the test prints, since stderr is dropped when the fixture exits cleanly.
		conversation.agent.joinSession(session, (error) =>
			note({ type: "pi's run for the host reported", error: String(error) }),
		);
	}
	stopHost = () => {
		// As the engine's release does for a stopping host, then the process ends before any turn does.
		conversation?.agent?.park();
		session.dispose();
		process.exit(0);
	};
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
	queued = () => session.agent.hasQueuedMessages();
	pending = () => session.getFollowUpMessages();
	note = (event) => events.push(event);
	let storeClosed = false;
	closeStore = async () => {
		storeClosed = true;
		await conversation?.close();
	};
	parkAndClose = async () => {
		// As the engine's release does for a stopping host, timing the close it waits on.
		conversation?.agent?.park();
		session.dispose();
		const from = Date.now();
		await conversation?.close();
		note({ type: "closed", ms: Date.now() - from });
		process.stdout.write(`${JSON.stringify({ events })}\n`);
		faux.unregister();
		if (!keptFolder) rmSync(folder, { recursive: true, force: true });
		process.exit(0);
	};
	const early = scenario.early?.(session);
	// The early run has reached the agent, as it had on 13 November.
	if (early) await Promise.race([reached, early]);
	const hosted = conversation?.agent;
	let typedIn = Promise.resolve();
	if (scenario.typed !== undefined && hosted) {
		const prompt = hosted.prompt.bind(hosted);
		typedIn = new Promise((reached) => {
			hosted.prompt = (...words) => {
				const answering = prompt(...words);
				reached();
				return answering;
			};
		});
	}
	const recovery = await hosted?.recover(
		scenario.turns
			? async (first) => {
					if (scenario.typed !== undefined) {
						note({ type: "turn asked", first: first() });
						// A turn comes free only once the agent has the words, as one would after Joel typed.
						await typedIn;
					}
					note({ type: "turn", first: first() });
					let given = false;
					// Only the first give-back counts, as with the host's own turns.
					return () => {
						if (given) return;
						given = true;
						note({ type: "turn given back" });
					};
				}
			: undefined,
	);
	const during =
		scenario.typed === undefined
			? scenario.during?.(session, hosted)
			: session.prompt(scenario.typed);
	await recovery?.settled;
	await early;
	await during;
	await scenario.drive(session);
	await session.agent.waitForIdle();
	const transcript = session.agent.state.messages.map(comparable);
	const pendingAtEnd = [...session.getFollowUpMessages()];
	session.dispose();
	if (!storeClosed) await conversation?.close();
	const ran = existsSync(effects())
		? readFileSync(effects(), "utf8").split("\n").filter(Boolean).length
		: 0;
	process.stdout.write(
		`${JSON.stringify({
			events,
			transcript,
			pendingAtEnd,
			lacking: pi.lacking.map((seam) => seam.patch),
			...(scenario.persist ? { ran } : {}),
		})}\n`,
	);
} finally {
	faux.unregister();
	if (!keptFolder) rmSync(folder, { recursive: true, force: true });
}

/**
 * An extension that adds a section to every run pi prepares, as the
 * harness's resident block does, and notes what began each run it
 * prepares: a person's words, a custom message or a run carried on.
 */
function sectioningExtension(pi: ExtensionPi): void {
	pi.on("before_agent_start", (event) => {
		note({ type: "prepared", trigger: event.messageType });
		const options = event.systemPromptOptions;
		if (!isRecord(options)) return;
		const sections = isRecord(options.sections) ? options.sections : {};
		options.sections = { ...sections, [SECTION_NAME]: SECTION };
	});
}

/**
 * An extension that kills the host as pi begins settling a run, writing
 * first what reopen-typed-as-it-ends saw and whether the agent still
 * queues its words, which only memory holds then.
 */
function settleKillingExtension(pi: ExtensionPi): void {
	pi.on("agent_settled", () => {
		writeFileSync(
			join(folder, TYPED_AS_IT_ENDS_FILE),
			JSON.stringify({ ...typedAsItEnds, queuedAtSettle: queued() }),
		);
		process.kill(process.pid, "SIGKILL");
	});
}

/**
 * An extension that takes STALL_MS to prepare each run the host carries
 * on, noting when it begins.
 */
function stallingExtension(pi: ExtensionPi): void {
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "continue") return;
		note({ type: "preparing" });
		preparingBegan();
		// A handler waiting on a slow service, as PREPARING_MS allows for.
		await new Promise((done) => setTimeout(done, STALL_MS));
	});
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

/**
 * Say `result` through an outbox wired as job-workflow wires it, told what
 * the session does by its events, and note how many prompts it sent and
 * how many were refused, once the result is seen or the wait ends.
 */
async function sayThroughAnOutbox(
	session: Session,
	result: { jobId: string; label: string; text: string },
): Promise<void> {
	let sends = 0;
	const box = createOutbox({
		send: (text) => {
			sends++;
			session.prompt(text).catch((error: unknown) => {
				note({ type: "prompt_refused", error: String(error) });
			});
		},
		steer: (text) => {
			if (session.isIdle) throw new Error("no run to put it in");
			void session.sendCustomMessage(
				{ customType: STEERED_RESULTS, content: text, display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		},
		idle: () => session.isIdle,
		now: Date.now,
		every: (ms, tick) => {
			const clock = setInterval(tick, ms);
			return () => clearInterval(clock);
		},
	});
	const stop = session.subscribe((event) => {
		if (event.type === "agent_start") box.runStarted();
		if (event.type === "agent_settled")
			box.runSettled(Reflect.get(event, "aborted") === true);
		const message: unknown = Reflect.get(event, "message");
		if (
			event.type === "message_end" &&
			isRecord(message) &&
			message.role === "user"
		)
			box.seen(textIn(message.content));
	});
	box.post(result);
	const by = Date.now() + OUTBOX_WAIT_MS;
	while (box.waiting().length > 0 && Date.now() < by) {
		// Polled: the outbox says nothing when a result leaves it.
		await new Promise((done) => setTimeout(done, OUTBOX_POLL_MS));
	}
	box.pause();
	stop();
	note({ type: "outbox", sends, waiting: box.waiting().length });
}

/**
 * An extension that tells an outbox what the session does through pi's
 * extension events, as job-workflow's does, steering and prompting as it
 * does, and notes each agent_settled it hears.
 */
function listeningExtension(session: () => Session) {
	return (pi: ExtensionPi): void => {
		let sends = 0;
		const box = createOutbox({
			send: (text) => {
				sends++;
				session()
					.prompt(text)
					.catch((error: unknown) => {
						note({ type: "prompt_refused", error: String(error) });
					});
			},
			steer: (text) => {
				if (session().isIdle) throw new Error("no run to put it in");
				void session().sendCustomMessage(
					{ customType: STEERED_RESULTS, content: text, display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			},
			idle: () => session().isIdle,
			now: Date.now,
			every: (ms, tick) => {
				const clock = setInterval(tick, ms);
				clock.unref();
				return () => clearInterval(clock);
			},
		});
		pi.on("agent_start", () => box.runStarted());
		pi.on("agent_settled", (event) => {
			note({ type: "agent_settled" });
			box.runSettled(event.aborted === true);
		});
		pi.on("message_end", (event) => {
			const { message } = event;
			if (isRecord(message) && message.role === "user")
				box.seen(textIn(message.content));
		});
		listened = { box, sends: () => sends };
	};
}

/**
 * Post `result` to the fixture's extension's outbox, and note how many
 * prompts it sent and what still waits, once the result is seen and the
 * session idle, or the wait ends.
 */
async function reportThroughTheExtension(
	session: Session,
	result: { jobId: string; label: string; text: string },
): Promise<void> {
	if (!listened) throw new Error("the scenario loads no extension");
	const { box, sends } = listened;
	box.post(result);
	const by = Date.now() + OUTBOX_WAIT_MS;
	while ((box.waiting().length > 0 || !session.isIdle) && Date.now() < by) {
		// Polled: the outbox says nothing when a result leaves it.
		await new Promise((done) => setTimeout(done, OUTBOX_POLL_MS));
	}
	box.pause();
	note({ type: "outbox", sends: sends(), waiting: box.waiting().length });
}

/** The text of a message's content. */
function textIn(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			const value: unknown = isRecord(part) ? part.text : undefined;
			return typeof value === "string" ? value : "";
		})
		.join("");
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
