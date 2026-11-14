/**
 * The host's agent: pi's Agent in shape, which AgentSession drives as its
 * own, with each run executed by the conversation's durable harness. pi
 * keeps what it always kept (state, queues, listeners, every hook pi's
 * session installs) and sees the events pi's agent loop emits, in its
 * order; durable admits inputs, makes the requests, runs the tools and
 * recovers a run a restart cut off. Nothing durable may still redo
 * reaches pi: an answer, a tool result or a placed input is shown only
 * once durable committed it, so the session file never holds it twice.
 */
import { randomUUID } from "node:crypto";
import type {
	Conversation,
	DurableContext,
	DurableModels,
	EntryRecord,
	GenerationHooks,
	HarnessSettings,
	Registry,
	Submission,
	ToolRegistration,
} from "./durable-types.ts";
import type { PiLibrary } from "./pi-library.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentListener,
	AgentMessage,
	AgentOptions,
	AgentTool,
	AssistantMessage,
	CompletedTurn,
	ContentBlock,
	Model,
	ProviderEvent,
	ProviderStream,
	QueueMode,
	StreamFn,
	ToolResultMessage,
	TurnUpdate,
} from "./pi-types.ts";
import { MessageQueue, type QueuedMessage } from "./queue.ts";
import { type Renewed, refusedOldKey } from "./renewing-stream.ts";
import {
	errorResult,
	resultMessage,
	ToolRound,
	terminates,
	toolCalls,
	truncatedCallText,
} from "./tool-round.ts";

/** Entry kinds the host writes its inputs as; durable keeps `pi.` for its own. */
export const INPUT_KINDS = {
	prompt: "host.prompt",
	steer: "host.steer",
	followUp: "host.follow-up",
} as const;

/** The data an input entry carries: pi's messages, as pi showed them. */
interface InputData {
	readonly hostId: string;
	readonly messages: readonly AgentMessage[];
}

/** What the agent needs of its conversation's durable side. */
export interface DurableBinding {
	readonly conversation: Conversation;
	readonly registry: Registry;
	readonly context: DurableContext;
	abortSubmission(id: number): Promise<string>;
	/** Let durable carry on what it had in flight, once the agent can answer its hooks. */
	resume(): void;
	/** Build the durable extension holding these tools and the agent's generation hooks. */
	extension(
		tools: readonly ToolRegistration[],
		hooks: GenerationHooks,
	): Parameters<Registry["install"]>[0];
	/** The conversation's environment, complete, for each request's credentials. */
	env(): Promise<Readonly<Record<string, string>>>;
	/**
	 * Whether a request's refusal came from a credential since renewed, so
	 * the request is worth sending once more.
	 */
	renewed?(error: AssistantMessage): Promise<boolean>;
	/**
	 * Run work as the conversation's own, so what reads the ambient
	 * conversation sees this one whoever scheduled the work: a run, each
	 * of durable's hooks, each request, each tool call and each listener.
	 */
	within?<T>(work: () => T): T;
}

interface Request {
	readonly model: Model;
	readonly reasoning: string | undefined;
	readonly messages: readonly AgentMessage[];
}

interface Run {
	readonly controller: AbortController;
	readonly newMessages: AgentMessage[];
	context: AgentContext;
	model: Model;
	reasoning: string | undefined;
	lastCompletedTurn?: CompletedTurn;
	/** The answer being streamed or awaiting durable's commit, with whether pi saw it start. */
	answer?: {
		message?: AssistantMessage;
		partial?: AssistantMessage;
		started: boolean;
	};
	request?: Request;
	round?: ToolRound;
	/** Inputs durable placed that pi has not seen, for the next request to show. */
	placed: AgentMessage[];
	/** Results durable committed that wait for their turn to be shown. */
	heldResults: EntryRecord[];
	ended: boolean;
	endDecided: boolean;
	/** Settles once the run's own input is in and pi saw it, before durable's hooks may act on it. */
	readonly ready: Promise<void>;
	/** Whether queued messages are admitted to durable as they come, which waits for the run's own input. */
	admitting: boolean;
	/** Whether pi saw the run start; a recovering run starts only once it has something to show. */
	opened: boolean;
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL: Model = {
	id: "unknown",
	provider: "unknown",
	api: "unknown",
};
const ENTRY_PAGE = 200;
/** A tool's parameters as durable sees them: pi validates the arguments itself, with its own texts. */
const ANY_ARGUMENTS = { type: "object" } as const;

/** The agent's state, as pi's Agent exposes it; tools and messages copy what is assigned. */
export interface HostedAgentState {
	readonly systemPrompt: string;
	model: Model;
	thinkingLevel: string;
	tools: AgentTool[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
}

/**
 * pi's agent, run through durable. Built from the exact options pi's
 * createAgentSession gives its own agent, so AgentSession installs every
 * hook on it as it would on pi's.
 */
export class HostedAgent {
	readonly state: HostedAgentState;
	convertToLlm: NonNullable<AgentOptions["convertToLlm"]>;
	transformContext: AgentOptions["transformContext"];
	streamFunction: StreamFn;
	getApiKey: AgentOptions["getApiKey"];
	onPayload: AgentOptions["onPayload"];
	onResponse: AgentOptions["onResponse"];
	onProviderStreamEvent: AgentOptions["onProviderStreamEvent"];
	beforeToolCall: AgentOptions["beforeToolCall"];
	afterToolCall: AgentOptions["afterToolCall"];
	finishTurn: AgentOptions["finishTurn"];
	prepareRequest: AgentOptions["prepareRequest"];
	prepareNextTurn: AgentOptions["prepareNextTurn"];
	prepareNextTurnWithContext: AgentOptions["prepareNextTurnWithContext"];
	sessionId: string | undefined;
	thinkingBudgets: unknown;
	transport: string;
	maxRetryDelayMs: number | undefined;
	toolExecution: "parallel" | "sequential";
	identity: unknown;

	private readonly listeners = new Set<AgentListener>();
	private readonly steeringQueue: MessageQueue;
	private readonly followUpQueue: MessageQueue;
	private active?: { promise: Promise<void>; resolve: () => void; run: Run };
	/**
	 * The newest durable entry pi has seen, or holds: found from the session
	 * file the first time it is needed, whether by the recovery or by a run
	 * something began before it, as an extension's start may.
	 */
	private cursor: number | undefined;
	/**
	 * The recovery, once begun: by the host, or by a prompt that came
	 * first, so each caller shares the one.
	 */
	private recovery: Promise<{ readonly settled: Promise<void> }> | undefined;
	private mirrorLine: Promise<unknown> = Promise.resolve();
	private admissions: Promise<unknown> = Promise.resolve();
	private readonly durable: DurableBinding;
	private readonly library: PiLibrary;

	constructor(
		options: AgentOptions,
		library: PiLibrary,
		durable: DurableBinding,
	) {
		this.library = library;
		this.durable = durable;
		this.state = createState(options.initialState, library, () =>
			this.install(),
		);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFunction = options.streamFn;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.onProviderStreamEvent = options.onProviderStreamEvent;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.finishTurn = options.finishTurn;
		this.prepareRequest = options.prepareRequest;
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
		this.steeringQueue = new MessageQueue(
			options.steeringMode ?? "one-at-a-time",
		);
		this.followUpQueue = new MessageQueue(
			options.followUpMode ?? "one-at-a-time",
		);
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.identity = options.identity;
		this.install();
	}

	// pi's Agent surface.

	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	steer(message: AgentMessage): void {
		this.queue(this.steeringQueue, message, "steer");
	}

	followUp(message: AgentMessage): void {
		this.queue(this.followUpQueue, message, "followUp");
	}

	clearSteeringQueue(): void {
		this.withdraw(this.steeringQueue.clear());
	}

	clearFollowUpQueue(): void {
		this.withdraw(this.followUpQueue.clear());
	}

	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	peekQueuedMessages(): AgentMessage[] {
		const steering = this.steeringQueue.peek();
		return (steering.length > 0 ? steering : this.followUpQueue.peek()).map(
			(item) => item.message,
		);
	}

	get signal(): AbortSignal | undefined {
		return this.active?.run.controller.signal;
	}

	/**
	 * Leave durable's run as it stands, for a host that is stopping. pi's
	 * session aborts its agent as it is disposed, and an abort now would be
	 * committed, where the next start should carry the run on. From here on
	 * abort does nothing and pi is shown nothing more; durable's close then
	 * stops the run without recording an outcome.
	 */
	park(): void {
		this.parked = true;
	}

	private parked = false;

	abort(): void {
		const active = this.active;
		if (!active || this.parked) return;
		active.run.controller.abort();
		// The run settles once durable's abort lands; its failure is reported there.
		void this.durable.conversation
			.abort(this.durable.context)
			.catch(() => undefined);
	}

	waitForIdle(): Promise<void> {
		return this.active?.promise ?? Promise.resolve();
	}

	reset(): void {
		if (this.active)
			throw new Error(
				"Agent is already processing. Wait for completion before resetting.",
			);
		const baseline = this.library.getCurrentSystemMessage(this.state.messages);
		this.state.messages = baseline ? [baseline] : [];
		this.state.isStreaming = false;
		this.state.streamingMessage = undefined;
		this.state.pendingToolCalls = new Set();
		this.state.errorMessage = undefined;
		this.clearAllQueues();
	}

	async prompt(
		input: string | AgentMessage | AgentMessage[],
		images?: readonly ContentBlock[],
	): Promise<void> {
		if (this.active) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = normalizePromptInput(input, images);
		if (!this.recovery) {
			// A prompt before the recovery, as an extension's start sends, begins
			// it: durable refuses new words as busy while it holds a turn a
			// restart cut off, and the words were lost (13 November).
			await this.recover().catch(() => {
				// The host reports the recovery's failure where it began it; the words go on.
			});
			if (await this.followCarriedOn(messages)) return;
		}
		await this.runPromptMessages(messages);
	}

	async continue(): Promise<void> {
		if (this.active)
			throw new Error(
				"Agent is already processing. Wait for completion before continuing.",
			);
		const last = this.state.messages.at(-1);
		if (
			!last ||
			this.state.messages.every((message) => message.role === "system")
		) {
			throw new Error("No messages to continue from");
		}
		if (last.role === "assistant") {
			const steering = this.steeringQueue.drain();
			if (steering.length > 0) {
				await this.runPromptMessages(steering.map((item) => item.message));
				return;
			}
			const followUps = this.followUpQueue.drain();
			if (followUps.length > 0) {
				await this.runPromptMessages(followUps.map((item) => item.message));
				return;
			}
			throw new Error("Cannot continue from message role: assistant");
		}
		await this.runWithLifecycle(async (run) => {
			await this.emit({ type: "agent_start" });
			await this.emit({ type: "turn_start" });
			await this.admit(run, { type: "continue" });
		});
	}

	/**
	 * Open the conversation, once pi's session holds the agent: let durable
	 * carry on whatever a restart cut off, as a run of pi's that starts only
	 * if there is something to show, beginning with what durable committed
	 * and the session file lacks. Resolves once durable resumed, so a host
	 * starting many conversations waits on none of their runs; settled
	 * resolves once the carried-on run ends. A fresh conversation has
	 * nothing to carry on and shows nothing.
	 */
	recover(): Promise<{ readonly settled: Promise<void> }> {
		this.recovery ??= this.recoverOnce();
		return this.recovery;
	}

	private async recoverOnce(): Promise<{ readonly settled: Promise<void> }> {
		// A run begun before the recovery, as by an extension's start, ends
		// first: durable admits nothing new while a turn it holds is cut off.
		while (this.active) await this.active.promise;
		this.cursor = await this.lastShown();
		let resumed = () => {};
		const started = new Promise<void>((done) => {
			resumed = done;
		});
		const settled = this.runWithLifecycle(async (run) => {
			const cut = this.cutOffAnswer();
			if (cut) this.startRound(run, cut, { recovered: true });
			this.durable.resume();
			resumed();
		});
		await Promise.race([started, settled]);
		return { settled };
	}

	/**
	 * Queue words behind the turn the recovery carries on, as pi queues a
	 * prompt while it is busy, so durable holds them through another restart
	 * rather than an unresolved prompt that nothing shows. False, with the
	 * recovery's run ended, when durable carried nothing on.
	 */
	private async followCarriedOn(
		messages: readonly AgentMessage[],
	): Promise<boolean> {
		const recovering = this.active;
		if (!recovering) return false;
		// Ready settles just as the run begins admitting what pi queues.
		await recovering.run.ready;
		if (recovering.run.admitting) {
			const items = messages.map((message) =>
				this.queue(this.followUpQueue, message, "followUp"),
			);
			await this.admissions;
			if (items[0]?.submissionId !== undefined) return true;
			// An idle conversation refused them: nothing carried on, so they run as a prompt.
			for (const item of items) this.followUpQueue.take(item.hostId);
		}
		while (this.active) await this.active.promise;
		return false;
	}

	/** The session's last answer when it called tools whose results the session file lacks. */
	private cutOffAnswer(): AssistantMessage | undefined {
		const messages = this.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (!message || message.role === "toolResult") continue;
			if (!isAssistant(message) || message.stopReason !== "toolUse")
				return undefined;
			const answered = new Set(
				messages
					.slice(index + 1)
					.flatMap((later) => (isToolResult(later) ? [later.toolCallId] : [])),
			);
			return toolCalls(message).some((call) => !answered.has(call.id))
				? message
				: undefined;
		}
		return undefined;
	}

	/** The models durable requests through: pi's stream, with pi's options, for each request. */
	readonly models: DurableModels = new Proxy(
		{
			getModel: (provider: string, id: string): Model | undefined => {
				const run = this.active?.run;
				for (const model of [run?.model, this.state.model]) {
					if (model && model.provider === provider && model.id === id)
						return model;
				}
				return undefined;
			},
			streamSimple: (
				_model: Model,
				_context: unknown,
				options?: Record<string, unknown>,
			) => this.stream(options ?? {}),
		},
		{
			get(target, name, receiver) {
				if (name in target) return Reflect.get(target, name, receiver);
				if (typeof name === "symbol" || name === "then") return undefined;
				// Present, since durable binds what it wraps; refused when called, so a new use shows at once.
				return () => {
					throw new Error(
						`The host's agent offers durable no Models.${name}; pi owns that`,
					);
				};
			},
		},
	);

	/** Run policy for durable: pi's queue modes and tool execution; pi owns retry and compaction. */
	settings(): HarnessSettings {
		return {
			retry: { enabled: false },
			compaction: { enabled: false },
			toolExecution: this.toolExecution,
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			afterFailedRun: "keep",
		};
	}

	// Runs.

	/**
	 * Settle once the next prompt is committed to durable, or reject with
	 * why it was not. The host's start waits on it to say a conversation's
	 * first words are safe.
	 */
	whenAdmitted(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.admissionWaiters.push({ resolve, reject });
		});
	}

	private readonly admissionWaiters: {
		resolve: () => void;
		reject: (error: unknown) => void;
	}[] = [];

	private settleAdmission(error?: unknown): void {
		for (const waiter of this.admissionWaiters.splice(0)) {
			if (error === undefined) waiter.resolve();
			else waiter.reject(error);
		}
	}

	private async runPromptMessages(prompts: AgentMessage[]): Promise<void> {
		await this.runWithLifecycle(async (run) => {
			const messages = this.declareToolChanges(run.context, prompts);
			try {
				await this.emit({ type: "agent_start" });
				await this.emit({ type: "turn_start" });
				const hostId = randomUUID();
				const data: InputData = { hostId, messages };
				// Marked before admission: durable may place it before pi is shown it here.
				this.shownInputs.add(hostId);
				await this.admit(run, {
					type: "input",
					content: userContent(messages),
					whenBusy: "reject",
					entry: { kind: INPUT_KINDS.prompt, data },
				});
			} catch (error) {
				this.settleAdmission(error);
				throw error;
			}
			this.settleAdmission();
			for (const message of messages) {
				await this.emit({ type: "message_start", message });
				await this.emit({ type: "message_end", message });
				run.context.messages.push(message);
				run.newMessages.push(message);
			}
		});
	}

	private readonly shownInputs = new Set<string>();

	private runWithLifecycle(start: (run: Run) => Promise<void>): Promise<void> {
		return this.within(() => this.lifecycle(start));
	}

	private within<T>(work: () => T): T {
		return this.durable.within ? this.durable.within(work) : work();
	}

	private async lifecycle(start: (run: Run) => Promise<void>): Promise<void> {
		if (this.active) throw new Error("Agent is already processing.");
		let resolve = () => {};
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		let started = () => {};
		const ready = new Promise<void>((done) => {
			started = done;
		});
		const run: Run = {
			ready,
			admitting: false,
			opened: false,
			controller: new AbortController(),
			newMessages: [],
			context: {
				messages: this.state.messages.slice(),
				tools: this.state.tools.slice(),
			},
			model: this.state.model,
			reasoning:
				this.state.thinkingLevel === "off"
					? undefined
					: this.state.thinkingLevel,
			placed: [],
			heldResults: [],
			ended: false,
			endDecided: false,
		};
		this.active = { promise, resolve, run };
		this.state.isStreaming = true;
		this.state.streamingMessage = undefined;
		this.state.errorMessage = undefined;
		try {
			try {
				await start(run);
			} finally {
				started();
			}
			run.admitting = true;
			this.readmitQueued();
			await this.settle(run);
		} catch (error) {
			await this.fail(run, error);
		} finally {
			run.admitting = false;
			await this.withdrawQueued();
			this.state.isStreaming = false;
			this.state.streamingMessage = undefined;
			this.state.pendingToolCalls = new Set();
			this.active = undefined;
			resolve();
		}
	}

	/** Admit the run's starting submission with the model it asks for. */
	private async admit(
		run: Run,
		submission: Parameters<Conversation["submit"]>[0],
	): Promise<Submission> {
		const { conversation, context } = this.durable;
		await conversation.configure(
			{ model: { provider: run.model.provider, modelId: run.model.id } },
			context,
		);
		return conversation.submit(submission, context);
	}

	/** Wait until durable is idle, show what it committed, and end the run as pi's loop ends it. */
	private async settle(run: Run): Promise<void> {
		await this.durable.conversation.waitForIdle(this.durable.context);
		await this.mirror(run, { showResults: true });
		if (run.ended) return;
		if (!run.opened) {
			// A recovery with nothing to carry on: pi saw no run, so none ends.
			run.ended = true;
			return;
		}
		const answer = run.answer;
		if (answer && !answer.message?.stopReason) {
			// durable ended the request without an answer it committed: an abort before any partial, or a failure.
			await this.endFailedTurn(run, this.unansweredMessage(run, answer));
			return;
		}
		if (answer?.message) {
			await this.endFailedTurn(run, answer.message);
			return;
		}
		if (run.round && !run.endDecided) {
			// Tools ran, then the run was aborted or cut off before the turn could close; pi closes it.
			await this.closeRound(run);
			if (run.ended) return;
		}
		if (run.placed.length > 0) {
			// Placed by a boundary whose run ended before its request, as after a failure.
			for (const message of run.placed.splice(0)) await this.show(run, message);
		}
		await this.emit({ type: "agent_end", messages: run.newMessages });
		run.ended = true;
	}

	private unansweredMessage(
		run: Run,
		answer: NonNullable<Run["answer"]>,
	): AssistantMessage {
		const aborted = run.controller.signal.aborted;
		return {
			...(answer.partial ?? {}),
			role: "assistant",
			content: answer.partial?.content ?? [{ type: "text", text: "" }],
			api: run.model.api,
			provider: run.model.provider,
			model: run.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			...(aborted
				? {}
				: { errorMessage: "The host's durable run ended without an answer" }),
			timestamp: answer.partial?.timestamp ?? Date.now(),
		};
	}

	/** An error or aborted answer ends the turn and the run, as pi's loop does. */
	private async endFailedTurn(
		run: Run,
		message: AssistantMessage,
	): Promise<void> {
		const answer = run.answer;
		run.answer = undefined;
		if (!answer?.started)
			await this.emit({ type: "message_start", message: { ...message } });
		await this.emit({ type: "message_end", message });
		run.newMessages.push(message);
		const turn: CompletedTurn = {
			message,
			toolResults: [],
			context: run.context,
			newMessages: run.newMessages,
		};
		run.lastCompletedTurn = turn;
		await this.finishTurn?.(turn, run.controller.signal);
		await this.emit({ type: "turn_end", message, toolResults: [] });
		await this.emit({ type: "agent_end", messages: run.newMessages });
		run.ended = true;
	}

	/** Close a round whose run was aborted after its tools, as pi's loop would on its next aborted request. */
	private async closeRound(run: Run): Promise<void> {
		const round = run.round;
		if (!round) return;
		const toolResults = round.calls.flatMap((call) => {
			const message = round.messages.get(call.id);
			return message ? [message] : [];
		});
		run.round = undefined;
		const turn: CompletedTurn = {
			message: round.assistant,
			toolResults,
			context: run.context,
			newMessages: run.newMessages,
		};
		run.lastCompletedTurn = turn;
		await this.finishTurn?.(turn, run.controller.signal);
		await this.emit({
			type: "turn_end",
			message: round.assistant,
			toolResults,
		});
		if (
			!run.controller.signal.aborted ||
			terminates([...round.outcomes.values()])
		)
			return;
		// pi's loop asks again after an aborted round, with the signal aborted, and ends on what the
		// provider answers; doing the same gives pi that provider's own aborted answer. No request
		// leaves the machine, since the provider sees the signal aborted before it sends.
		await this.prepareTurnRequest(run);
		const stream = this.stream({ signal: run.controller.signal });
		for await (const _event of stream) {
			// Each event is shown to pi by the tee as it passes.
		}
		await stream.result();
		const answer = run.answer?.message;
		if (!answer)
			throw new Error("pi's stream ended an aborted request without an answer");
		await this.endFailedTurn(run, answer);
	}

	private async fail(run: Run, error: unknown): Promise<void> {
		if (run.ended) throw error;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this.state.model.api,
			provider: this.state.model.provider,
			model: this.state.model.id,
			usage: EMPTY_USAGE,
			stopReason: run.controller.signal.aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		await this.emit({ type: "message_start", message });
		await this.emit({ type: "message_end", message });
		await this.emit({ type: "turn_end", message, toolResults: [] });
		await this.emit({ type: "agent_end", messages: [message] });
		run.ended = true;
	}

	// Durable's hooks.

	private readonly hooks: GenerationHooks = {
		beforeRequest: async () => this.within(() => this.beforeRequest()),
		onCommittedTurn: async (turn) =>
			this.within(() => this.committedTurn(turn)),
	};

	/**
	 * The run a hook belongs to, once pi saw its input. Durable may carry
	 * on with no run of pi's open, as when it wakes after the run that
	 * recovered it settled; pi is then shown a run of its own, as for a
	 * recovery, rather than refused.
	 */
	private async runForHook(): Promise<Run> {
		if (!(this.active || this.parked)) this.carryOn();
		const run = this.currentRun();
		await run.ready;
		return run;
	}

	/** Open a run for what durable does on its own; it ends once durable is idle. */
	private carryOn(): void {
		this.runWithLifecycle(async () => {}).catch(() => {
			// The run's failure is shown to pi as its end; nobody awaits it here.
		});
	}

	private currentRun(): Run {
		const run = this.active?.run;
		if (!run) throw new Error("Durable asked the host's agent outside a run");
		return run;
	}

	private async beforeRequest(): Promise<{
		readonly messages: readonly AgentMessage[];
	}> {
		const run = await this.runForHook();
		await this.mirror(run, { showResults: true });
		return { messages: await this.prepareTurnRequest(run) };
	}

	/** pi's steps before a request: the next turn, what it places, prepareRequest and the context hooks. */
	private async prepareTurnRequest(run: Run): Promise<readonly AgentMessage[]> {
		const prepared = run.lastCompletedTurn ? await this.nextTurn(run) : [];
		const placed = run.placed.splice(0);
		for (const message of this.declareToolChanges(run.context, [
			...prepared,
			...placed,
		])) {
			await this.show(run, message);
		}
		const update = await this.prepareRequest?.(
			{
				context: run.context,
				model: run.model,
				thinkingLevel: run.reasoning ?? "off",
			},
			run.controller.signal,
		);
		this.applyUpdate(run, update);
		let messages = run.context.messages;
		if (this.transformContext)
			messages = await this.transformContext(messages, run.controller.signal);
		const converted = await this.convertToLlm(messages);
		const normalized = this.library.normalizeContext({ messages: converted });
		run.request = {
			model: run.model,
			reasoning: run.reasoning,
			messages: normalized.messages,
		};
		run.answer = { started: false };
		return normalized.messages;
	}

	/** pi's next-turn step: prepareNextTurn, then turn_start; answers the messages it prepared. */
	private async nextTurn(run: Run): Promise<AgentMessage[]> {
		const completed = run.lastCompletedTurn;
		let prepared: AgentMessage[] = [];
		if (
			completed &&
			(this.prepareNextTurnWithContext || this.prepareNextTurn)
		) {
			const update = this.prepareNextTurnWithContext
				? await this.prepareNextTurnWithContext(
						completed,
						run.controller.signal,
					)
				: await this.prepareNextTurn?.(run.controller.signal);
			if (update) {
				run.context = update.context ?? run.context;
				prepared = [...(update.messages ?? [])];
				this.applyModel(run, update);
			}
		}
		await this.emit({ type: "turn_start" });
		return prepared;
	}

	private applyUpdate(run: Run, update: TurnUpdate | undefined): void {
		if (!update) return;
		run.context = update.context ?? run.context;
		this.applyModel(run, update);
	}

	private applyModel(run: Run, update: TurnUpdate): void {
		run.model = update.model ?? run.model;
		if (update.thinkingLevel !== undefined) {
			run.reasoning =
				update.thinkingLevel === "off" ? undefined : update.thinkingLevel;
		}
	}

	/**
	 * Durable committed an answer and every result of its round: pi ends the
	 * turn and says what follows. A turn whose answer pi showed before a
	 * restart, with the decision cut off, is rebuilt from the session; one
	 * pi holds no answer for at all ends, since pi has no turn to close.
	 */
	private async committedTurn(committed: {
		readonly assistant: number;
	}): Promise<{
		readonly action: "end" | "continue";
	}> {
		const run = await this.runForHook();
		await this.mirror(run, { showResults: true });
		const round = run.round;
		run.round = undefined;
		let message: AssistantMessage | undefined =
			round?.assistant ?? this.lastAnswer(run);
		let toolResults: ToolResultMessage[] = [];
		if (round) {
			// A result the session held before a restart is its own, not the round's.
			toolResults = round.calls.flatMap((call) => {
				const shown =
					round.messages.get(call.id) ??
					resultOf(run.context.messages, call.id);
				return shown ? [shown] : [];
			});
		} else if (message) {
			const calls = toolCalls(message);
			if (message.stopReason === "length" && calls.length > 0) {
				toolResults = await this.failTruncatedCalls(run, message);
			}
		} else {
			message = await this.answerShownBefore(run, committed.assistant);
			if (message) toolResults = resultsOf(run.context.messages, message);
		}
		if (!message) {
			run.endDecided = true;
			return { action: "end" };
		}
		const turn: CompletedTurn = {
			message,
			toolResults,
			context: run.context,
			newMessages: run.newMessages,
		};
		run.lastCompletedTurn = turn;
		const decision = await this.finishTurn?.(turn, run.controller.signal);
		await this.emit({ type: "turn_end", message, toolResults });
		if (decision?.action === "end") {
			run.endDecided = true;
			return { action: "end" };
		}
		const moreTools =
			toolResults.length > 0 &&
			!(round ? terminates([...round.outcomes.values()]) : false);
		await this.admissions;
		if (moreTools || this.steeringQueue.hasItems())
			return { action: "continue" };
		// pi runs follow-ups before honouring a continue; durable places them when this turn ends.
		if (decision?.action === "continue" && !this.followUpQueue.hasItems())
			return { action: "continue" };
		return { action: "end" };
	}

	private lastAnswer(run: Run): AssistantMessage | undefined {
		const last = lastOfRole(run.newMessages, "assistant");
		return last && isAssistant(last) ? last : undefined;
	}

	/**
	 * The answer durable committed as `entryId`, as the session already
	 * holds it: a restart came after pi showed it, before durable heard
	 * what follows it. On 13 November a helper resumed with its tool's
	 * result shown and the decision cut off, and its turn was refused.
	 */
	private async answerShownBefore(
		run: Run,
		entryId: number,
	): Promise<AssistantMessage | undefined> {
		const { conversation, context } = this.durable;
		const page = await conversation.entries(
			{ minEntryId: entryId, order: "ascending" },
			1,
			undefined,
			context,
		);
		const [committed] =
			page.items.find((entry) => entry.id === entryId)?.model ?? [];
		if (!committed) return undefined;
		const key = messageKey(committed);
		const shown = newest(
			run.context.messages,
			(message) => messageKey(message) === key,
		);
		return shown && isAssistant(shown) ? shown : undefined;
	}

	/** pi fails every call of an answer cut off at its output limit, and continues. */
	private async failTruncatedCalls(
		run: Run,
		message: AssistantMessage,
	): Promise<ToolResultMessage[]> {
		const results: ToolResultMessage[] = [];
		for (const toolCall of toolCalls(message)) {
			await this.emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			const outcome = {
				toolCall,
				result: errorResult(truncatedCallText(toolCall.name)),
				isError: true,
			};
			await this.emit({
				type: "tool_execution_end",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				result: outcome.result,
				isError: true,
			});
			const shown = resultMessage(outcome);
			await this.show(run, shown);
			results.push(shown);
		}
		return results;
	}

	// The provider stream.

	private stream(options: Record<string, unknown>): ProviderStream {
		// Only beforeRequest, which waited for the run, prepares a request.
		const run = this.currentRun();
		const request = run.request;
		if (!request)
			throw new Error(
				"Durable requested before the host's agent prepared the request",
			);
		const signal =
			options.signal instanceof AbortSignal
				? options.signal
				: run.controller.signal;
		const durablePayload = isPayloadHook(options.onPayload)
			? options.onPayload
			: undefined;
		const renewed = this.durable.renewed?.bind(this.durable);
		const open = (): Promise<ProviderStream> =>
			this.within(() => this.open(request, signal, durablePayload));
		return this.tee(run, request, open, renewed);
	}

	/** Send one request through pi's stream function, with the conversation's credentials. */
	private async open(
		request: Request,
		signal: AbortSignal,
		durablePayload: PayloadHook | undefined,
	): Promise<ProviderStream> {
		const apiKey = this.getApiKey
			? await this.getApiKey(request.model.provider)
			: undefined;
		const env = await this.durable.env();
		return this.streamFunction(
			request.model,
			{ messages: request.messages },
			{
				model: request.model,
				reasoning: request.reasoning,
				sessionId: this.sessionId,
				onPayload: async (payload: unknown, model: Model) => {
					const ours = this.onPayload
						? await this.onPayload(payload, model)
						: undefined;
					const next = ours === undefined ? payload : ours;
					return durablePayload ? durablePayload(next, model) : next;
				},
				onResponse: this.onResponse,
				onProviderStreamEvent: this.onProviderStreamEvent,
				transport: this.transport,
				thinkingBudgets: this.thinkingBudgets,
				maxRetryDelayMs: this.maxRetryDelayMs,
				toolExecution: this.toolExecution,
				...(apiKey ? { apiKey } : {}),
				identity: this.library.mergeClientIdentity(
					this.library.defaultAgentIdentity,
					this.identity,
				),
				signal,
				env: { ...env },
			},
		);
	}

	/** Show pi the stream's events as its loop does, and hand durable the same stream. */
	private tee(
		run: Run,
		request: Request,
		open: () => Promise<ProviderStream>,
		renewed: Renewed | undefined,
	): ProviderStream {
		const answer = run.answer ?? { started: false };
		run.answer = answer;
		let final: Promise<AssistantMessage> | undefined;
		const finish = async (
			stream: ProviderStream,
		): Promise<AssistantMessage> => {
			final ??= (async () => {
				const message = await stream.result();
				message.thinkingLevel = request.reasoning ?? "off";
				const messages = run.context.messages;
				if (answer.started) messages[messages.length - 1] = message;
				else messages.push(message);
				answer.message = message;
				return message;
			})();
			return final;
		};
		// pi's loop reads the provider's own stream as it arrives and tells
		// extensions each event then; durable reads at its own pace, so the
		// stream is read here, unwrapped, and durable is handed what was read.
		const read: ProviderEvent[] = [];
		let ended = false;
		let failure: { readonly error: unknown } | undefined;
		let wake = () => {};
		let opened = open();
		const reading = (async () => {
			let stream = await opened;
			// Only the first event of the first stream can be a refused key.
			let renewable = renewed;
			for (;;) {
				let reopen = false;
				for await (const event of stream) {
					const asked = renewable;
					renewable = undefined;
					// Only an error is awaited, so a start reaches pi when its loop's would.
					if (
						asked &&
						event.type === "error" &&
						(await refusedOldKey(event, asked))
					) {
						reopen = true;
						break;
					}
					if (event.type === "start" && event.partial) {
						answer.partial = event.partial;
						run.context.messages.push(event.partial);
						answer.started = true;
						await this.emit({
							type: "message_start",
							message: { ...event.partial },
						});
					} else if (event.type === "done" || event.type === "error") {
						await finish(stream);
					} else if (answer.started && event.partial) {
						answer.partial = event.partial;
						run.context.messages[run.context.messages.length - 1] =
							event.partial;
						await this.emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...event.partial },
						});
					}
					read.push(event);
					wake();
				}
				if (!reopen) break;
				opened = open();
				stream = await opened;
			}
			await finish(stream);
		})().then(
			() => {
				ended = true;
				wake();
			},
			(error: unknown) => {
				// Held for durable, which meets it when it reads this far.
				failure = { error };
				wake();
			},
		);
		const events = async function* (): AsyncGenerator<ProviderEvent> {
			for (;;) {
				const event = read.shift();
				if (event) {
					yield event;
					continue;
				}
				if (failure) throw failure.error;
				if (ended) return;
				await new Promise<void>((done) => {
					wake = done;
				});
			}
		};
		const iterable = events();
		return {
			[Symbol.asyncIterator]: () => iterable,
			result: async () => {
				await reading;
				return { ...(await finish(await opened)) };
			},
		};
	}

	// Tools.

	private install(): void {
		const tools = this.state.tools.map((tool) => this.durableTool(tool));
		this.durable.registry.install(this.durable.extension(tools, this.hooks));
	}

	private durableTool(tool: AgentTool): ToolRegistration {
		return {
			name: tool.name,
			description: tool.description ?? "",
			parameters: ANY_ARGUMENTS,
			replay: "unsafe",
			...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
			execute: (_args, api, context) =>
				this.within(() => this.executeTool(api.callId, context.abortSignal)),
		};
	}

	/** Run one of a round's calls as pi's loop would, once durable asks for it. */
	private async executeTool(
		callId: string,
		abortSignal: AbortSignal | undefined,
	): Promise<Awaited<ReturnType<ToolRegistration["execute"]>>> {
		const run = await this.runForHook();
		const round = await this.roundFor(run);
		if (round.sequential) await this.mirror(run, { showResults: true });
		const outcome = await round.run(callId, abortSignal);
		return {
			output: outcome.result.content ?? [],
			isError: outcome.isError,
			details: jsonCopy(outcome.result.details),
			...(outcome.result.usage === undefined
				? {}
				: { usage: outcome.result.usage }),
		};
	}

	private async roundFor(run: Run): Promise<ToolRound> {
		if (!run.round) await this.mirror(run, { showResults: false });
		if (!run.round)
			throw new Error(
				"Durable ran a tool before the host's agent saw its answer committed",
			);
		return run.round;
	}

	private startRound(
		run: Run,
		assistant: AssistantMessage,
		options: { recovered?: boolean } = {},
	): ToolRound {
		run.round = new ToolRound(
			{
				library: this.library,
				hooks: {
					beforeToolCall: this.beforeToolCall,
					afterToolCall: this.afterToolCall,
				},
				sequential: this.toolExecution === "sequential",
				recovered: options.recovered === true,
				emit: (event) => this.emit(event),
			},
			assistant,
			run.context,
			run.controller.signal,
		);
		return run.round;
	}

	// Mirroring durable's transcript to pi.

	/** Show pi, in order, every entry durable committed since the last one it saw. */
	private mirror(run: Run, options: { showResults: boolean }): Promise<void> {
		const next = this.mirrorLine.then(() => this.mirrorNow(run, options));
		this.mirrorLine = next.catch(() => undefined);
		return next;
	}

	private async mirrorNow(
		run: Run,
		options: { showResults: boolean },
	): Promise<void> {
		for (const entry of await this.unseen()) {
			this.cursor = entry.id;
			await this.mirrorEntry(run, entry);
		}
		if (options.showResults) {
			for (const entry of this.inCallOrder(run, run.heldResults.splice(0)))
				await this.showResult(run, entry);
		}
	}

	/** Results in their calls' order, as pi shows a round's results; durable commits them as they finish. */
	private inCallOrder(run: Run, entries: EntryRecord[]): EntryRecord[] {
		const order = new Map(
			(run.round?.calls ?? []).map((call, index) => [call.id, index]),
		);
		const place = (entry: EntryRecord): number => {
			const [message] = entry.model ?? [];
			const id =
				message && isToolResult(message) ? message.toolCallId : undefined;
			return (id === undefined ? undefined : order.get(id)) ?? order.size;
		};
		return entries
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => place(a.entry) - place(b.entry) || a.index - b.index)
			.map(({ entry }) => entry);
	}

	private async mirrorEntry(run: Run, entry: EntryRecord): Promise<void> {
		const input = inputData(entry);
		if (input) {
			if (this.shownInputs.has(input.hostId)) return;
			this.steeringQueue.take(input.hostId);
			this.followUpQueue.take(input.hostId);
			run.placed.push(...input.messages);
			return;
		}
		const [message] = entry.model ?? [];
		if (entry.kind === "pi.user" && message) {
			run.placed.push(message);
			return;
		}
		if (entry.kind === "pi.assistant" && message && isAssistant(message)) {
			await this.mirrorAnswer(run, message);
			return;
		}
		if (entry.kind === "pi.tool-result" && message) {
			run.heldResults.push(entry);
		}
	}

	private async mirrorAnswer(
		run: Run,
		committed: AssistantMessage,
	): Promise<void> {
		const answer = run.answer;
		const message = answer?.message ?? committed;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			// Settled with the run, as pi ends a turn on such an answer.
			run.answer = { ...(answer ?? { started: false }), message };
			return;
		}
		run.answer = undefined;
		if (!answer?.started) {
			await this.emit({ type: "message_start", message: { ...message } });
			if (!answer) run.context.messages.push(message);
		}
		await this.emit({ type: "message_end", message });
		run.newMessages.push(message);
		if (message.stopReason === "toolUse" && toolCalls(message).length > 0)
			this.startRound(run, message);
	}

	/**
	 * Show a result durable committed, as its round made it. One the
	 * session already holds is shown once only; one whose call is in no
	 * round pi has open is shown as durable committed it, so a result left
	 * over from before a restart can never break the round after it.
	 */
	private async showResult(run: Run, entry: EntryRecord): Promise<void> {
		const [committed] = entry.model ?? [];
		if (!committed || !isToolResult(committed)) return;
		if (resultShown(run.context.messages, committed.toolCallId)) return;
		const round = run.round;
		let shown = round?.messages.get(committed.toolCallId);
		const called = round?.calls.some(
			(call) => call.id === committed.toolCallId,
		);
		if (!shown && round && called) {
			await round.settleUnrun(
				committed.toolCallId,
				unrunText(entry, committed),
			);
			shown = round.messages.get(committed.toolCallId);
		}
		await this.show(run, shown ?? committed);
	}

	private async show(run: Run, message: AgentMessage): Promise<void> {
		await this.emit({ type: "message_start", message });
		await this.emit({ type: "message_end", message });
		run.context.messages.push(message);
		run.newMessages.push(message);
	}

	/** Entries newer than the cursor, oldest first. */
	private async unseen(): Promise<EntryRecord[]> {
		const { conversation, context } = this.durable;
		this.cursor ??= await this.lastShown();
		const from = this.cursor;
		const found: EntryRecord[] = [];
		let cursor: unknown;
		do {
			const page = await conversation.entries(
				{ minEntryId: from + 1, order: "ascending" },
				ENTRY_PAGE,
				cursor,
				context,
			);
			found.push(...page.items.filter((entry) => entry.id > from));
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	}

	/**
	 * The newest durable entry the session file already holds, matched by
	 * what a pi message keeps of it: an input's id, a message's role,
	 * timestamp and tool call.
	 */
	private async lastShown(): Promise<number> {
		const kept = new Set(this.state.messages.map(messageKey));
		const { conversation, context } = this.durable;
		let cursor: unknown;
		do {
			const page = await conversation.entries(
				{ order: "descending" },
				ENTRY_PAGE,
				cursor,
				context,
			);
			for (const entry of page.items) {
				const messages =
					inputData(entry)?.messages ??
					(entry.kind === "pi.system" ? [] : (entry.model ?? []));
				if (messages.some((message) => kept.has(messageKey(message))))
					return entry.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return 0;
	}

	// Queues.

	private queue(
		queue: MessageQueue,
		message: AgentMessage,
		mode: "steer" | "followUp",
	): QueuedMessage {
		const item: QueuedMessage = { hostId: randomUUID(), message };
		queue.enqueue(item);
		if (this.active?.run.admitting) this.admitQueued(item, mode);
		return item;
	}

	private admitQueued(item: QueuedMessage, mode: "steer" | "followUp"): void {
		const data: InputData = { hostId: item.hostId, messages: [item.message] };
		const { conversation, context } = this.durable;
		this.admissions = this.admissions.then(async () => {
			try {
				const submission = await conversation.submit(
					{
						type: "input",
						content: userContent([item.message]),
						whenBusy: mode,
						whenIdle: "reject",
						entry: {
							kind: mode === "steer" ? INPUT_KINDS.steer : INPUT_KINDS.followUp,
							data,
						},
					},
					context,
				);
				item.submissionId = submission.id;
			} catch {
				// An idle conversation refuses it: it stays in pi's queue for the next prompt or continue, as in pi.
			}
		});
	}

	/** Durable copies of what pi still queues, admitted once the run's own input is in. */
	private readmitQueued(): void {
		for (const item of this.steeringQueue.all()) {
			if (item.submissionId === undefined) this.admitQueued(item, "steer");
		}
		for (const item of this.followUpQueue.all()) {
			if (item.submissionId === undefined) this.admitQueued(item, "followUp");
		}
	}

	private async withdrawQueued(): Promise<void> {
		await this.admissions;
		const held = [...this.steeringQueue.all(), ...this.followUpQueue.all()];
		await Promise.all(held.map((item) => this.withdrawOne(item)));
	}

	private withdraw(items: readonly QueuedMessage[]): void {
		for (const item of items) void this.withdrawOne(item);
	}

	private async withdrawOne(item: QueuedMessage): Promise<void> {
		const id = item.submissionId;
		if (id === undefined) return;
		item.submissionId = undefined;
		await this.durable.abortSubmission(id).catch(() => "settled");
	}

	// Events.

	private declareToolChanges(
		context: AgentContext,
		pending: AgentMessage[],
	): AgentMessage[] {
		return declareToolChanges(this.library, context, pending);
	}

	/** Reduce state for an event, as pi's Agent does, then await every listener in order. */
	private async emit(event: AgentEvent): Promise<void> {
		if (this.parked) return;
		const run = this.active?.run;
		if (run && !run.opened) {
			run.opened = true;
			if (event.type !== "agent_start") {
				// A recovering run shows pi the run and the turn it carries on before its first event.
				await this.emit({ type: "agent_start" });
				await this.emit({ type: "turn_start" });
			}
		}
		const state = this.state;
		switch (event.type) {
			case "message_start":
			case "message_update":
				state.streamingMessage = event.message;
				break;
			case "message_end":
				state.streamingMessage = undefined;
				state.messages.push(event.message);
				break;
			case "tool_execution_start": {
				const pending = new Set(state.pendingToolCalls);
				pending.add(event.toolCallId);
				state.pendingToolCalls = pending;
				break;
			}
			case "tool_execution_end": {
				const pending = new Set(state.pendingToolCalls);
				pending.delete(event.toolCallId);
				state.pendingToolCalls = pending;
				break;
			}
			case "turn_end":
				if (isAssistant(event.message) && event.message.errorMessage) {
					state.errorMessage = event.message.errorMessage;
				}
				break;
			case "agent_end":
				state.streamingMessage = undefined;
				break;
		}
		const signal = this.active?.run.controller.signal;
		if (!signal) throw new Error("Agent listener invoked outside active run");
		for (const listener of this.listeners)
			await this.within(() => listener(event, signal));
	}
}

/** A hook that may replace a request's payload, as pi's and durable's onPayload do. */
type PayloadHook = (payload: unknown, model: Model) => unknown;

/** Durable's payload hook, which its options carry untyped. */
function isPayloadHook(value: unknown): value is PayloadHook {
	return typeof value === "function";
}

function createState(
	initial: AgentOptions["initialState"],
	library: PiLibrary,
	toolsChanged: () => void,
): HostedAgentState {
	let tools = initial?.tools?.slice() ?? [];
	let messages = initial?.messages?.slice() ?? [];
	const first = library.createInitialSystemMessage(
		initial?.systemPrompt,
		tools.map(library.toToolDeclaration),
	);
	if (messages[0]?.role !== "system" && first) messages.unshift(first);
	let ready = false;
	const state: HostedAgentState = {
		get systemPrompt() {
			return library.getCurrentSystemPrompt(messages);
		},
		model: initial?.model ?? DEFAULT_MODEL,
		thinkingLevel: initial?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(next: AgentTool[]) {
			tools = next.slice();
			if (ready) toolsChanged();
		},
		get messages() {
			return messages;
		},
		set messages(next: AgentMessage[]) {
			messages = next.slice();
		},
		isStreaming: false,
		pendingToolCalls: new Set(),
	};
	ready = true;
	return state;
}

/** pi's declareToolChanges: tell the model what tools changed since the transcript last said. */
function declareToolChanges(
	library: PiLibrary,
	context: AgentContext,
	pending: AgentMessage[],
): AgentMessage[] {
	let systemIndex = -1;
	for (let index = pending.length - 1; index >= 0; index--) {
		if (pending[index]?.role === "system") {
			systemIndex = index;
			break;
		}
	}
	const system = systemIndex >= 0 ? pending[systemIndex] : undefined;
	const noChanges = { toolsAdded: [], toolsRemoved: [] };
	const baseline = system
		? pending.map((message, index) =>
				index === systemIndex ? withToolChanges(message, noChanges) : message,
			)
		: pending;
	const changes = library.getToolStateChanges(
		library.getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(library.toToolDeclaration),
	);
	const unchanged =
		changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;
	if (system) {
		const declares = (field: unknown) =>
			Array.isArray(field) && field.length > 0;
		if (
			unchanged &&
			!declares(system.toolsAdded) &&
			!declares(system.toolsRemoved)
		)
			return pending;
		return baseline.map((message, index) =>
			index === systemIndex ? withToolChanges(system, changes) : message,
		);
	}
	if (unchanged) return pending;
	const update = withToolChanges(
		{ role: "system", content: "", timestamp: Date.now() },
		changes,
	);
	const insert = pending.findIndex((message) => message.role !== "system");
	const at = insert === -1 ? pending.length : insert;
	return [...pending.slice(0, at), update, ...pending.slice(at)];
}

function withToolChanges(
	message: AgentMessage,
	changes: {
		readonly toolsAdded: readonly unknown[];
		readonly toolsRemoved: readonly unknown[];
	},
): AgentMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		role: message.role,
		...(changes.toolsAdded.length > 0
			? { toolsAdded: changes.toolsAdded }
			: {}),
		...(changes.toolsRemoved.length > 0
			? { toolsRemoved: changes.toolsRemoved }
			: {}),
	};
}

function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) =>
		["system", "user", "assistant", "toolResult"].includes(message.role),
	);
}

function normalizePromptInput(
	input: string | AgentMessage | AgentMessage[],
	images?: readonly ContentBlock[],
): AgentMessage[] {
	if (Array.isArray(input)) return input;
	if (typeof input !== "string") return [input];
	const content: ContentBlock[] = [
		{ type: "text", text: input },
		...(images ?? []),
	];
	return [{ role: "user", content, timestamp: Date.now() }];
}

/** What durable's own context gets for pi's input: its user content, else its text. */
function userContent(
	messages: readonly AgentMessage[],
): string | readonly ContentBlock[] {
	const user = lastOfRole(messages, "user");
	const content = user?.content ?? messages.at(-1)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const blocks = content.filter(
			(block): block is ContentBlock =>
				typeof block === "object" &&
				block !== null &&
				(block.type === "text" || block.type === "image"),
		);
		if (blocks.length > 0) return blocks;
	}
	return "(input)";
}

function lastOfRole(
	messages: readonly AgentMessage[],
	role: string,
): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === role) return message;
	}
	return undefined;
}

function inputData(entry: EntryRecord): InputData | undefined {
	if (!Object.values(INPUT_KINDS).some((kind) => kind === entry.kind))
		return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const { hostId, messages } = data as Partial<InputData>;
	if (typeof hostId !== "string" || !Array.isArray(messages)) return undefined;
	return { hostId, messages };
}

/**
 * What a session message and the durable entry it came from share: a
 * result's call, or another message's role and timestamp. A result is
 * not matched by its time, since pi shows the one its round made, a
 * moment before durable commits its own: on 13 November the two were
 * 1 ms apart, so a resume took the result as unshown, showed it again
 * and broke the round after it.
 */
function messageKey(message: AgentMessage): string {
	if (typeof message.toolCallId === "string")
		return `${message.role}\u0000call\u0000${message.toolCallId}`;
	return `${message.role}\u0000${String(message.timestamp)}`;
}

/** Whether `messages` already hold a result for the call `callId`. */
function resultShown(
	messages: readonly AgentMessage[],
	callId: string,
): boolean {
	return resultOf(messages, callId) !== undefined;
}

/** The newest result `messages` hold for the call `callId`. */
function resultOf(
	messages: readonly AgentMessage[],
	callId: string,
): ToolResultMessage | undefined {
	const found = newest(
		messages,
		(message) => isToolResult(message) && message.toolCallId === callId,
	);
	return found && isToolResult(found) ? found : undefined;
}

/** The newest of `messages` that `matches`. */
function newest(
	messages: readonly AgentMessage[],
	matches: (message: AgentMessage) => boolean,
): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && matches(message)) return message;
	}
	return undefined;
}

/** The results `messages` hold for `answer`'s calls, in call order. */
function resultsOf(
	messages: readonly AgentMessage[],
	answer: AssistantMessage,
): ToolResultMessage[] {
	return toolCalls(answer).flatMap((call) => {
		const result = resultOf(messages, call.id);
		return result ? [result] : [];
	});
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" && typeof message.toolCallId === "string"
	);
}

/** pi's text for a result durable wrote for a call no tool ran. */
function unrunText(entry: EntryRecord, committed: ToolResultMessage): string {
	const data = entry.data as
		| { diagnostics?: readonly { code?: string }[] }
		| undefined;
	const codes = new Set(
		(data?.diagnostics ?? []).map((diagnostic) => diagnostic.code),
	);
	if (codes.has("tool_unavailable"))
		return `Tool ${committed.toolName} not found`;
	if (codes.has("aborted")) return "Operation aborted";
	// pi has no text of its own for this: a restart is the host's. Said plainly, as pi says its errors.
	if (codes.has("interrupted")) {
		return `Tool ${committed.toolName} was interrupted by a restart and may have partially run`;
	}
	const text = committed.content.find((block) => block.type === "text")?.text;
	return text ?? `Tool ${committed.toolName} did not run`;
}

function jsonCopy(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		// A value JSON cannot hold is pi's to keep; durable stores none.
		return undefined;
	}
}
