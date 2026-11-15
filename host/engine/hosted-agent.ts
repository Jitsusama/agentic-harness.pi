/**
 * The host's agent: pi's Agent in shape, which AgentSession drives as its
 * own, with each run executed by the conversation's durable harness. pi
 * keeps what it always kept (state, queues, listeners, every hook pi's
 * session installs) and sees the events pi's agent loop emits, in its
 * order; durable admits inputs, makes the requests, runs the tools and
 * recovers a run a restart cut off. Nothing durable may still redo
 * reaches pi: an answer, a tool result or a placed input is shown only
 * once durable committed it, so the session file never holds it twice.
 * What it leans on lives beside it in hosted-agent/: what a run holds,
 * the agent's state, the provider stream, durable's transcript mirrored
 * to pi, and reading pi's messages.
 */
import { randomUUID } from "node:crypto";
import { isPersonWords } from "../../lib/internal/session/driven.ts";
import type {
	Conversation,
	DurableModels,
	GenerationHooks,
	HarnessSettings,
	RunFailure,
	Submission,
	ToolRegistration,
} from "./durable-types.ts";
import type {
	DurableBinding,
	QueueShowingSession,
	ShowQueued,
} from "./hosted-agent/binding.ts";
import {
	cutOffAnswer,
	defaultConvertToLlm,
	isAssistant,
	jsonCopy,
	lastOfRole,
	normalizePromptInput,
	queuedText,
	resultOf,
	resultsOf,
	userContent,
} from "./hosted-agent/messages.ts";
import {
	isPayloadHook,
	openRequest,
	teeStream,
} from "./hosted-agent/provider-stream.ts";
import {
	applyModel,
	EMPTY_USAGE,
	INPUT_KINDS,
	type InputData,
	type Run,
	unansweredMessage,
} from "./hosted-agent/run.ts";
import { createState, type HostedAgentState } from "./hosted-agent/state.ts";
import { declareToolChanges } from "./hosted-agent/tool-changes.ts";
import { Transcript } from "./hosted-agent/transcript.ts";
import { pairToolResults } from "./paired-results.ts";
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
	ProviderStream,
	QueueMode,
	StreamFn,
	ToolResultMessage,
	TurnUpdate,
} from "./pi-types.ts";
import { MessageQueue, type QueuedMessage } from "./queue.ts";
import {
	beganWithPersonsWords,
	type GiveBack,
	type TakeTurn,
} from "./resume-turns.ts";
import {
	errorResult,
	resultMessage,
	ToolRound,
	terminates,
	toolCalls,
	truncatedCallText,
} from "./tool-round.ts";

export type {
	DurableBinding,
	QueueShowingSession,
	ShowQueued,
} from "./hosted-agent/binding.ts";
export type { HostedAgentState } from "./hosted-agent/state.ts";

/** Durable's reason for a run whose request the host stopped during. */
const INTERRUPTED = "interrupted";
/** A tool's parameters as durable sees them: pi validates the arguments itself, with its own texts. */
const ANY_ARGUMENTS = { type: "object" } as const;

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
	 * The recovery, once begun: by the host, or by a prompt that came
	 * first, so each caller shares the one.
	 */
	private recovery: Promise<{ readonly settled: Promise<void> }> | undefined;
	/** Gives back a carried run's turn as the first answer streamed after the restart ends. */
	private answered: GiveBack | undefined;

	/** Whether words Joel typed have come in, which move a run waiting for its turn up. */
	private joelTyped = false;
	private admissions: Promise<unknown> = Promise.resolve();
	private readonly durable: DurableBinding;
	private readonly library: PiLibrary;
	private readonly transcript: Transcript;
	/** Where words this agent queues past pi's session show as pending, once the host gives it. */
	private pending: ShowQueued | undefined;

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
		this.transcript = new Transcript({
			durable,
			state: this.state,
			steering: this.steeringQueue,
			followUp: this.followUpQueue,
			emit: (event) => this.emit(event),
			startRound: (run, assistant) => this.startRound(run, assistant),
		});
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
		this.parking.abort();
	}

	private parked = false;

	/** Ends a carried run's wait for its turn when the conversation parks. */
	private readonly parking = new AbortController();

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
		const messages = normalizePromptInput(input, images);
		if (messages.some((message) => isPersonWords({ type: "message", message })))
			this.joelTyped = true;
		if (this.active) {
			// pi begins a run only while it holds none, so one under way here is
			// durable's: the recovery carrying a turn on, or durable's own work.
			// The words queue behind it as an early prompt's do. Refused, pi,
			// idle by its own account, let job-workflow say its cut-off notice
			// again at once, 335 times in one conversation, and two resumes
			// took 72 s each (14 November).
			if (await this.followCarriedOn(messages)) return;
		} else if (!this.recovery) {
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
		if (this.active) {
			// pi continues only once its own prompt has ended, so a run under way
			// here is durable's: the ask again for a request a restart cut off,
			// begun as the recovery that held pi's words ended. Refused, words
			// typed while the run waited for its turn failed as the agent already
			// processing (15 November); followed, its answer is what pi continues to.
			while (this.active) await this.active.promise;
			if (
				this.state.messages.at(-1)?.role === "assistant" &&
				!this.hasQueuedMessages()
			)
				return;
		}
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
	 * Show the words this agent queues itself, past pi's session, in that
	 * session's pending list, where pi has the seam: pi's session lists only
	 * what it queued, so without it they show nowhere until their turn starts.
	 */
	showQueuedIn(session: QueueShowingSession): void {
		if (typeof session.showQueued !== "function") return;
		this.pending = (text, mode) => session.showQueued?.(text, mode);
	}

	/**
	 * Open the conversation, once pi's session holds the agent: let durable
	 * carry on whatever a restart cut off, as a run of pi's that starts only
	 * if there is something to show, beginning with what durable committed
	 * and the session file lacks. Resolves once durable resumed, or once
	 * the run it carries waits for its turn, so a host starting many
	 * conversations waits on none of their runs; settled resolves once the
	 * carried-on run ends. A fresh conversation has nothing to carry on and
	 * shows nothing. Given `turn`, a run a restart cut off waits for one
	 * before durable carries it on, and gives it back as the first answer
	 * streamed after the restart ends, its own or the ask again's, or once
	 * the run ends first, so a host coming back starts only a few at once
	 * and a run that goes on for an hour holds up no other.
	 */
	recover(turn?: TakeTurn): Promise<{ readonly settled: Promise<void> }> {
		this.recovery ??= this.recoverOnce(turn);
		return this.recovery;
	}

	private async recoverOnce(
		turn: TakeTurn | undefined,
	): Promise<{ readonly settled: Promise<void> }> {
		// A run begun before the recovery, as by an extension's start, ends
		// first: durable admits nothing new while a turn it holds is cut off.
		while (this.active) await this.active.promise;
		await this.transcript.placeAtSession();
		const before = await this.durable.runFailure();
		const waits = turn !== undefined && (await this.durable.carrying());
		let giveBack: GiveBack = () => {};
		let resumed = () => {};
		const started = new Promise<void>((done) => {
			resumed = done;
		});
		const settled = this.runWithLifecycle(async (run) => {
			if (waits) {
				// Words said meanwhile queue behind this run, as behind any other.
				resumed();
				const began = beganWithPersonsWords(this.state.messages);
				giveBack = await turn(
					() => began || this.joelTyped,
					AbortSignal.any([run.controller.signal, this.parking.signal]),
				);
				this.answered = giveBack;
				// Parked while it waited: durable keeps the run for the start that opens it next.
				if (this.parked) return;
			}
			const cut = cutOffAnswer(this.state.messages);
			if (cut) this.startRound(run, cut, { recovered: true });
			this.durable.resume();
			resumed();
		});
		await Promise.race([started, settled]);
		return {
			settled: settled
				.then(() => this.askAgainIfCutOff(before))
				.finally(() => {
					this.answered = undefined;
					giveBack();
				}),
		};
	}

	/**
	 * Ask the model again when the run the recovery carried on ended because
	 * the host stopped during its request. Durable retries such a request
	 * only under its own retry, which stays off since pi owns model retries,
	 * so the turn would otherwise sit unanswered until a new word arrived,
	 * as one did for four minutes on 14 November. A failure from before this
	 * recovery is left alone, and so is `restart_limit`, durable's own end to
	 * a request cut off again and again.
	 */
	private async askAgainIfCutOff(
		before: RunFailure | undefined,
	): Promise<void> {
		if (this.parked || this.active) return;
		const failure = await this.durable.runFailure();
		if (failure?.reason !== INTERRUPTED || failure.taskId === before?.taskId)
			return;
		if (this.parked || this.active) return;
		await this.runWithLifecycle(async (run) => {
			await this.emit({ type: "agent_start" });
			await this.emit({ type: "turn_start" });
			await this.admit(run, { type: "continue" });
		});
	}

	/**
	 * Queue words behind the turn the recovery carries on, as pi queues a
	 * prompt while it is busy, so durable holds them through another restart
	 * rather than only an unresolved prompt. True once the run that answers
	 * them ended, as pi's agent resolves a prompt: pi's session continues
	 * the agent once it does. False, with the recovery's run ended, when
	 * durable carried nothing on.
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
			// Shown at once, as pi shows its own queued words: pi takes each off
			// as its message starts, whether durable answers it after the turn
			// or refused it and it runs as a prompt below.
			for (const message of messages) {
				const text = queuedText(message);
				if (text) this.pending?.(text, "followUp");
			}
			await this.admissions;
			if (items[0]?.submissionId !== undefined) {
				while (this.active) await this.active.promise;
				return true;
			}
			// An idle conversation refused them: nothing carried on, so they run as a prompt.
			for (const item of items) this.followUpQueue.take(item.hostId);
		}
		while (this.active) await this.active.promise;
		return false;
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
				this.transcript.markShown(hostId);
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
		await this.transcript.mirror(run, { showResults: true });
		if (run.ended) return;
		if (!run.opened) {
			// A recovery with nothing to carry on: pi saw no run, so none ends.
			run.ended = true;
			return;
		}
		const answer = run.answer;
		if (answer && !answer.message?.stopReason) {
			// durable ended the request without an answer it committed: an abort before any partial, or a failure.
			await this.endFailedTurn(run, unansweredMessage(run, answer));
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
			for (const message of run.placed.splice(0))
				await this.transcript.show(run, message);
		}
		await this.emit({ type: "agent_end", messages: run.newMessages });
		run.ended = true;
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
		await this.transcript.mirror(run, { showResults: true });
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
			await this.transcript.show(run, message);
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
		const converted = pairToolResults(await this.convertToLlm(messages));
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
				applyModel(run, update);
			}
		}
		await this.emit({ type: "turn_start" });
		return prepared;
	}

	private applyUpdate(run: Run, update: TurnUpdate | undefined): void {
		if (!update) return;
		run.context = update.context ?? run.context;
		applyModel(run, update);
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
		await this.transcript.mirror(run, { showResults: true });
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
			message = await this.transcript.answerShownBefore(
				run,
				committed.assistant,
			);
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
			await this.transcript.show(run, shown);
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
			this.within(() =>
				openRequest(
					this,
					this.library,
					this.durable,
					request,
					signal,
					durablePayload,
				),
			);
		return teeStream(run, request, signal, open, renewed, {
			emit: (event) => this.emit(event),
			answered: () => {
				const answered = this.answered;
				this.answered = undefined;
				answered?.();
			},
		});
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
		if (round.sequential)
			await this.transcript.mirror(run, { showResults: true });
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
		if (!run.round) await this.transcript.mirror(run, { showResults: false });
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
