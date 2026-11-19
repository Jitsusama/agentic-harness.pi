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
 * to pi, pi's turns around each request, the queued words given to
 * durable, the recovery, and reading pi's messages. Long because what
 * stays is pi's Agent surface itself, every method AgentSession calls,
 * each of which must answer as pi's does; splitting it further would
 * scatter one contract across files that change together.
 */
import { randomUUID } from "node:crypto";
import { isPersonWords } from "../../lib/internal/session/driven.ts";
import type {
	Conversation,
	DurableModels,
	GenerationHooks,
	HarnessSettings,
	Submission,
	ToolRegistration,
} from "./durable-types.ts";
import { Admissions, type WordsWatch } from "./hosted-agent/admissions.ts";
import type {
	DurableBinding,
	QueueShowingSession,
	ShowQueued,
} from "./hosted-agent/binding.ts";
import {
	defaultConvertToLlm,
	jsonCopy,
	normalizePromptInput,
	userContent,
} from "./hosted-agent/messages.ts";
import { type HostRunningSession, PiRuns } from "./hosted-agent/pi-runs.ts";
import {
	durableModels,
	isPayloadHook,
	openRequest,
	teeStream,
} from "./hosted-agent/provider-stream.ts";
import { Recovery } from "./hosted-agent/recovery.ts";
import {
	type ActiveRun,
	EMPTY_USAGE,
	INPUT_KINDS,
	type InputData,
	type Run,
	unansweredMessage,
} from "./hosted-agent/run.ts";
import {
	createState,
	type HostedAgentState,
	reduce,
} from "./hosted-agent/state.ts";
import { declareToolChanges } from "./hosted-agent/tool-changes.ts";
import { Transcript } from "./hosted-agent/transcript.ts";
import { Turns } from "./hosted-agent/turns.ts";
import type { PiLibrary } from "./pi-library.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentListener,
	AgentMessage,
	AgentOptions,
	AgentTool,
	AssistantMessage,
	ContentBlock,
	ProviderStream,
	QueueMode,
	StreamFn,
} from "./pi-types.ts";
import { MessageQueue, type QueuedMessage } from "./queue.ts";
import type { TakeTurn } from "./resume-turns.ts";
import { ToolRound } from "./tool-round.ts";

export type {
	DurableBinding,
	QueueShowingSession,
	ShowQueued,
} from "./hosted-agent/binding.ts";
export type { HostedAgentState } from "./hosted-agent/state.ts";

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
	private active?: ActiveRun;

	/** Whether words Joel typed have come in, which move a run waiting for its turn up. */
	private joelTyped = false;
	private readonly durable: DurableBinding;
	private readonly library: PiLibrary;
	private readonly transcript: Transcript;
	private readonly admissions: Admissions;
	private readonly turns: Turns;
	private readonly recovery: Recovery;
	/** Where words this agent queues past pi's session show as pending, once the host gives it. */
	private pending: ShowQueued | undefined;
	private readonly piRuns = new PiRuns(
		() => this.parked,
		(say) => this.within(say),
		() => {
			// Words left queued once pi's run settled run next, as after pi's own; a run's failure shows in it.
			if (this.hasQueuedMessages()) void this.continue().catch(() => undefined);
		},
		// Words queued as the agent's last run ended run inside pi's run, as pi's own run goes on to them before it settles.
		{ ids: () => this.queuedIds(), run: () => this.continue() },
	);

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
		this.admissions = new Admissions(
			durable,
			this.steeringQueue,
			this.followUpQueue,
		);
		this.turns = new Turns(this, {
			library,
			transcript: this.transcript,
			steering: this.steeringQueue,
			followUp: this.followUpQueue,
			emit: (event) => this.emit(event),
			stream: (options) => this.stream(options),
			admitted: () => this.admissions.settled(),
		});
		this.recovery = new Recovery({
			durable,
			state: this.state,
			transcript: this.transcript,
			followUp: this.followUpQueue,
			admissions: this.admissions,
			parking: this.parking.signal,
			active: () => this.active,
			parked: () => this.parked,
			joelTyped: () => this.joelTyped,
			pending: () => this.pending,
			runWithLifecycle: (start) => this.runWithLifecycle(start),
			continueRun: () => this.continueRun(),
			holdPiRun: () => this.piRuns.hold(),
			startRound: (run, assistant, options) =>
				this.startRound(run, assistant, options),
			queue: (queue, message, mode) => this.queue(queue, message, mode),
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
		this.admissions.withdraw(this.steeringQueue.clear());
	}

	clearFollowUpQueue(): void {
		this.admissions.withdraw(this.followUpQueue.clear());
	}

	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** The host's ids of the words pi's queues hold. */
	private queuedIds(): string[] {
		return [...this.steeringQueue.all(), ...this.followUpQueue.all()].map(
			(item) => item.hostId,
		);
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
		this.admissions.given(messages);
		if (messages.some((message) => isPersonWords({ type: "message", message })))
			this.joelTyped = true;
		if (this.active) {
			// pi begins a run only while it holds none, so one under way is durable's. The words
			// queue behind it as an early prompt's do; refused, pi, idle by its own account, let
			// job-workflow say its cut-off notice 335 times; two resumes took 72 s (14 November).
			if (await this.recovery.followCarriedOn(messages)) return;
		} else if (!this.recovery.begun) {
			// A prompt before the recovery, as an extension's start sends, begins it: durable refuses
			// new words while it holds a turn a restart cut off, and they were lost (13 November).
			// The host reports the recovery's failure where it began it; the words go on.
			await this.recover().catch(() => undefined);
			if (await this.recovery.followCarriedOn(messages)) return;
		}
		await this.runPromptMessages(messages);
	}

	async continue(): Promise<void> {
		if (this.active) {
			// pi continues only once its prompt ended, so a run under way is durable's: the ask
			// again for a request a restart cut off. Refused, words typed meanwhile failed as the
			// agent already processing (15 November); followed, pi continues to its answer.
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
				await this.promptOrThrow(steering.map((item) => item.message));
				return;
			}
			const followUps = this.followUpQueue.drain();
			if (followUps.length > 0) {
				await this.promptOrThrow(followUps.map((item) => item.message));
				return;
			}
			throw new Error("Cannot continue from message role: assistant");
		}
		await this.continueOrThrow();
	}

	/**
	 * Join the pi session holding this agent. Words the agent queues past it
	 * show in its pending list, where pi has the seam, as pi lists only what
	 * it queued. The agent's own runs open as pi's there (pi-runs.ts), and
	 * one pi fails to prepare, or prepares too late, is said to `report`.
	 */
	joinSession(
		session: QueueShowingSession & HostRunningSession,
		report?: (error: unknown) => void,
	): void {
		this.piRuns.tell(session, report);
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
		return this.recovery.recover(turn);
	}

	/** The models durable requests through: pi's stream, with pi's options, for each request. */
	readonly models: DurableModels = durableModels({
		run: () => this.active?.run,
		model: () => this.state.model,
		stream: (options) => this.stream(options),
	});

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

	/** Watch for words pi gives until `signal` stops it, settled once durable holds them: an open's first words wait on it. */
	watchWords(signal?: AbortSignal): WordsWatch {
		return this.admissions.watch(signal);
	}

	/**
	 * Words pi queued, run for pi's continue: as `runPromptMessages`, but a
	 * refused admission throws once the run has failed, as `continueOrThrow`
	 * does, so pi's loop ends on a closed session whichever branch it took.
	 * The words are lost with the session, as any run's would be.
	 */
	private async promptOrThrow(prompts: AgentMessage[]): Promise<void> {
		let refused: { readonly error: unknown } | undefined;
		await this.runPromptMessages(prompts, (error) => {
			refused = { error };
		});
		if (refused) throw refused.error;
	}

	private async runPromptMessages(
		prompts: AgentMessage[],
		refusedBy?: (error: unknown) => void,
	): Promise<void> {
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
				this.admissions.committed(prompts, error);
				refusedBy?.(error);
				throw error;
			}
			this.admissions.committed(prompts);
			for (const message of messages) {
				await this.emit({ type: "message_start", message });
				await this.emit({ type: "message_end", message });
				run.context.messages.push(message);
				run.newMessages.push(message);
			}
		});
	}

	/** pi's continue: a run that asks the model again on what the session holds. */
	private continueRun(): Promise<Run> {
		return this.continueRunRefusing().then(({ run }) => run);
	}

	/**
	 * pi's continue for pi's own run loop: as `continueRun`, but one durable
	 * refused to admit, as a closed or failed session refuses every one at
	 * once, ends as a failed run and then throws what refused it. pi's loop
	 * asks again while words wait or a settle boundary wants more, so a
	 * continue that only fails is asked again forever in one microtask
	 * chain, starving the host's loop past its watchdog (the held profile of
	 * 18 November, 09:02). The recovery's ask again keeps `continueRun`: it
	 * wants the run back, failed or not, and nothing above it would catch a
	 * throw.
	 */
	private async continueOrThrow(): Promise<void> {
		const { refused } = await this.continueRunRefusing();
		if (refused) throw refused.error;
	}

	private async continueRunRefusing(): Promise<{
		readonly run: Run;
		readonly refused?: { readonly error: unknown };
	}> {
		let refused: { readonly error: unknown } | undefined;
		const run = await this.runWithLifecycle(async (started) => {
			await this.emit({ type: "agent_start" });
			await this.emit({ type: "turn_start" });
			try {
				await this.admit(started, { type: "continue" });
			} catch (error) {
				refused = { error };
				throw error;
			}
		});
		return refused ? { run, refused } : { run };
	}

	private runWithLifecycle(start: (run: Run) => Promise<void>): Promise<Run> {
		return this.within(() => this.piRuns.holding(() => this.lifecycle(start)));
	}

	private within<T>(work: () => T): T {
		return this.durable.within ? this.durable.within(work) : work();
	}

	private async lifecycle(start: (run: Run) => Promise<void>): Promise<Run> {
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
			this.admissions.readmitQueued();
			await this.settle(run);
		} catch (error) {
			await this.fail(run, error);
		} finally {
			run.admitting = false;
			await this.admissions.withdrawQueued();
			this.state.isStreaming = false;
			this.state.streamingMessage = undefined;
			this.state.pendingToolCalls = new Set();
			this.active = undefined;
			resolve();
		}
		return run;
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
			await this.turns.endFailedTurn(run, unansweredMessage(run, answer));
			return;
		}
		if (answer?.message) {
			await this.turns.endFailedTurn(run, answer.message);
			return;
		}
		if (run.round && !run.endDecided) {
			// Tools ran, then the run was aborted or cut off before the turn could close; pi closes it.
			await this.turns.closeRound(run);
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
			this.within(async () =>
				this.turns.committedTurn(await this.runForHook(), turn),
			),
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
		// A failure is shown to pi as the run's end, and pi settles it as its own.
		this.runWithLifecycle(async () => {}).catch(() => undefined);
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
		return { messages: await this.turns.prepareTurnRequest(run) };
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
			answered: () => this.recovery.answer(),
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
		this.admissions.given([message]);
		if (this.active?.run.admitting) this.admissions.admitQueued(item, mode);
		return item;
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
			// Pi's prepared messages go in the next request, after any owed tool result (pi-runs.ts).
			// A park stops the wait too, so a stopping host's close waits on no preparation it abandoned.
			const stopped = AbortSignal.any([
				run.controller.signal,
				this.parking.signal,
			]);
			run.placed.push(...(await this.piRuns.opening(stopped)));
			if (this.parked) return;
			if (event.type !== "agent_start") {
				// A recovering run shows pi the run and the turn it carries on before its first event.
				await this.emit({ type: "agent_start" });
				await this.emit({ type: "turn_start" });
			}
		}
		reduce(this.state, event);
		const signal = this.active?.run.controller.signal;
		if (!signal) throw new Error("Agent listener invoked outside active run");
		for (const listener of this.listeners)
			await this.within(() => listener(event, signal));
	}
}
