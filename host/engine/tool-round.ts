/**
 * One round of tool calls, run as pi's agent loop runs it: each call's
 * start, its preparation (argument repair, validation, beforeToolCall),
 * execution with updates, afterToolCall and its end, in pi's order for
 * parallel and sequential rounds. Durable runs each call as a task; the
 * round decides what pi sees and when, so the events match ordinary pi.
 * The steps copy pi-agent-core's agent-loop.ts, whose order and texts the
 * parity scenarios compare.
 *
 * One step is the host's own: every credential a tool prints is put out
 * of sight, in each streamed update before any viewer sees it and in the
 * final result before durable commits it, whether or not the conversation
 * loads the secret-scrub extension. pi's afterToolCall still sees the raw
 * result, as on pi, and a result with nothing to hide passes untouched.
 */
import { scrubDeep, scrubSecrets } from "../../lib/internal/secrets.ts";
import type { PiLibrary } from "./pi-library.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentHooks,
	AgentTool,
	AgentToolResult,
	AssistantMessage,
	ContentBlock,
	ToolCall,
	ToolResultMessage,
} from "./pi-types.ts";

/** A call's outcome before it becomes a message. */
export interface CallOutcome {
	readonly toolCall: ToolCall;
	readonly result: AgentToolResult;
	readonly isError: boolean;
	readonly durationMs?: number;
}

type Preparation =
	| {
			readonly kind: "prepared";
			readonly toolCall: ToolCall;
			readonly tool: AgentTool;
			readonly args: unknown;
	  }
	| {
			readonly kind: "immediate";
			readonly result: AgentToolResult;
			readonly isError: boolean;
	  };

/** What a round needs from the agent running it. */
export interface RoundAgent {
	readonly library: PiLibrary;
	readonly hooks: Pick<AgentHooks, "beforeToolCall" | "afterToolCall">;
	readonly sequential: boolean;
	/**
	 * A round a restart cut off: some calls were prepared by the process that
	 * died, so none is prepared again with the rest; each is taken alone.
	 */
	readonly recovered?: boolean;
	emit(event: AgentEvent): Promise<void>;
}

/** pi's text for an error result. */
export function errorResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

/** pi's tool result message for an outcome. */
export function resultMessage(outcome: CallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: outcome.toolCall.id,
		toolName: outcome.toolCall.name,
		content: outcome.result.content ?? [],
		details: outcome.result.details,
		usage: outcome.result.usage,
		isError: outcome.isError,
		...(outcome.durationMs === undefined
			? {}
			: { durationMs: outcome.durationMs }),
		timestamp: Date.now(),
	};
}

/** The calls of an assistant message, in order. */
export function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter(
		(block): block is ToolCall & typeof block => block.type === "toolCall",
	);
}

/** Whether pi would end the run after this round: every result asked to terminate. */
export function terminates(outcomes: readonly CallOutcome[]): boolean {
	return (
		outcomes.length > 0 &&
		outcomes.every((outcome) => outcome.result.terminate === true)
	);
}

/**
 * The round for one assistant message. Its calls run when durable asks
 * (`run`); calls durable never runs, such as one to an unknown tool, are
 * settled here at their place in pi's order. Each result message is kept
 * until durable commits the call's result, and only then shown to pi.
 */
export class ToolRound {
	readonly calls: readonly ToolCall[];
	/** Messages built for each call, by call id, waiting for durable's commit. */
	readonly messages = new Map<string, ToolResultMessage>();
	/** Calls whose start and end pi has seen. */
	readonly ended = new Set<string>();
	readonly outcomes = new Map<string, CallOutcome>();
	private readonly preparations = new Map<string, Promise<Preparation>>();
	private allPrepared: Promise<void> | undefined;
	readonly assistant: AssistantMessage;
	private readonly agent: RoundAgent;
	private readonly context: AgentContext;
	private readonly signal: AbortSignal | undefined;

	constructor(
		agent: RoundAgent,
		assistant: AssistantMessage,
		context: AgentContext,
		signal: AbortSignal | undefined,
	) {
		this.agent = agent;
		this.assistant = assistant;
		this.context = context;
		this.signal = signal;
		this.calls = toolCalls(assistant);
	}

	/** Whether pi runs this round one call after another. */
	get sequential(): boolean {
		const tools = this.context.tools ?? [];
		return (
			this.agent.sequential ||
			this.agent.recovered === true ||
			this.calls.some(
				(call) =>
					tools.find((tool) => tool.name === call.name)?.executionMode ===
					"sequential",
			)
		);
	}

	/**
	 * Run one call as durable's task for it, returning pi's outcome. In a
	 * parallel round every call is started and prepared in call order first,
	 * as pi's loop does before any executes.
	 */
	async run(
		callId: string,
		signal: AbortSignal | undefined,
	): Promise<CallOutcome> {
		const toolCall = this.calls.find((call) => call.id === callId);
		if (!toolCall)
			throw new Error(`The assistant message has no tool call ${callId}`);
		if (this.sequential) {
			const preparation = await this.start(toolCall);
			return this.finish(toolCall, preparation, signal);
		}
		this.allPrepared ??= this.prepareAll();
		await this.allPrepared;
		const preparation = await this.preparations.get(callId);
		if (!preparation) throw new Error(`Tool call ${callId} was never prepared`);
		if (preparation.kind === "immediate") {
			// Settled and ended while preparing, as pi does.
			const outcome = this.outcomes.get(callId);
			if (!outcome) throw new Error(`Tool call ${callId} has no outcome`);
			return outcome;
		}
		if (this.signal?.aborted) {
			return this.end({
				toolCall,
				result: errorResult("Operation aborted"),
				isError: true,
			});
		}
		return this.finish(toolCall, preparation, signal);
	}

	/**
	 * Settle calls durable never ran, such as a call to a tool the agent
	 * lacks, in pi's order: in a parallel round as their preparation, in a
	 * sequential one when its turn comes, which the caller marks by awaiting
	 * this before showing the next result.
	 */
	async settleUnrun(callId: string, text: string): Promise<CallOutcome> {
		const known = this.outcomes.get(callId);
		if (known) return known;
		const toolCall = this.calls.find((call) => call.id === callId);
		if (!toolCall)
			throw new Error(`The assistant message has no tool call ${callId}`);
		if (!this.sequential) {
			this.allPrepared ??= this.prepareAll();
			await this.allPrepared;
			const settled = this.outcomes.get(callId);
			if (settled) return settled;
		}
		if (!this.ended.has(callId)) await this.startEvent(toolCall);
		return this.end({ toolCall, result: errorResult(text), isError: true });
	}

	private prepareAll(): Promise<void> {
		return (async () => {
			for (const call of this.calls) {
				const preparation = this.start(call);
				const settled = await preparation;
				if (settled.kind === "immediate") {
					await this.end({
						toolCall: call,
						result: settled.result,
						isError: settled.isError,
					});
				}
				if (this.signal?.aborted) break;
			}
		})();
	}

	private start(toolCall: ToolCall): Promise<Preparation> {
		const preparation = (async () => {
			await this.startEvent(toolCall);
			return this.prepare(toolCall);
		})();
		this.preparations.set(toolCall.id, preparation);
		return preparation;
	}

	private async startEvent(toolCall: ToolCall): Promise<void> {
		await this.agent.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
	}

	private async prepare(toolCall: ToolCall): Promise<Preparation> {
		const tool = (this.context.tools ?? []).find(
			(candidate) => candidate.name === toolCall.name,
		);
		if (!tool) {
			return {
				kind: "immediate",
				result: errorResult(`Tool ${toolCall.name} not found`),
				isError: true,
			};
		}
		try {
			const prepared = prepareArguments(tool, toolCall);
			const args = this.agent.library.validateToolArguments(tool, prepared);
			const before = this.agent.hooks.beforeToolCall;
			if (before) {
				const decision = await before(
					{
						assistantMessage: this.assistant,
						toolCall,
						args,
						context: this.context,
					},
					this.signal,
				);
				if (this.signal?.aborted) {
					return {
						kind: "immediate",
						result: errorResult("Operation aborted"),
						isError: true,
					};
				}
				if (decision?.block) {
					const result = errorResult(
						decision.reason || "Tool execution was blocked",
					);
					if (decision.terminate === true) result.terminate = true;
					return { kind: "immediate", result, isError: true };
				}
			}
			if (this.signal?.aborted) {
				return {
					kind: "immediate",
					result: errorResult("Operation aborted"),
					isError: true,
				};
			}
			return { kind: "prepared", toolCall, tool, args };
		} catch (error) {
			return {
				kind: "immediate",
				result: errorResult(messageOf(error)),
				isError: true,
			};
		}
	}

	private async finish(
		toolCall: ToolCall,
		preparation: Preparation,
		signal: AbortSignal | undefined,
	): Promise<CallOutcome> {
		if (preparation.kind === "immediate") {
			return this.end({
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			});
		}
		const executed = await this.execute(preparation, signal);
		return this.end(await this.afterCall(preparation, executed));
	}

	private async execute(
		prepared: Extract<Preparation, { kind: "prepared" }>,
		signal: AbortSignal | undefined,
	): Promise<CallOutcome> {
		const updates: Promise<void>[] = [];
		let accepting = true;
		const startedAt = performance.now();
		const elapsed = () => Math.round(performance.now() - startedAt);
		const { toolCall } = prepared;
		try {
			const result = await prepared.tool.execute(
				toolCall.id,
				prepared.args as never,
				signal,
				(partialResult) => {
					if (!accepting) return;
					updates.push(
						this.agent.emit({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: toolCall.arguments,
							partialResult: scrubbedResult(partialResult),
						}),
					);
				},
			);
			const durationMs = elapsed();
			accepting = false;
			await Promise.all(updates);
			return { toolCall, result, isError: result.isError === true, durationMs };
		} catch (error) {
			const durationMs = elapsed();
			accepting = false;
			await Promise.all(updates);
			return {
				toolCall,
				result: errorResult(messageOf(error)),
				isError: true,
				durationMs,
			};
		} finally {
			accepting = false;
		}
	}

	private async afterCall(
		prepared: Extract<Preparation, { kind: "prepared" }>,
		executed: CallOutcome,
	): Promise<CallOutcome> {
		const after = this.agent.hooks.afterToolCall;
		if (!after) return executed;
		let { result, isError } = executed;
		try {
			const changed = await after(
				{
					assistantMessage: this.assistant,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: this.context,
				},
				this.signal,
			);
			if (changed) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					changed.structuredContent ??
					(changed.content ? undefined : result.structuredContent);
				const merged: AgentToolResult = {
					...result,
					content: changed.content ?? result.content,
					details: changed.details ?? result.details,
					usage: changed.usage ?? result.usage,
					terminate: changed.terminate ?? result.terminate,
				};
				const { structuredContent: _dropped, ...rest } = merged;
				result =
					structuredContent === undefined
						? rest
						: { ...rest, structuredContent };
				isError = changed.isError ?? isError;
			}
		} catch (error) {
			result = errorResult(messageOf(error));
			isError = true;
		}
		return {
			toolCall: prepared.toolCall,
			result,
			isError,
			...(executed.durationMs === undefined
				? {}
				: { durationMs: executed.durationMs }),
		};
	}

	private async end(settled: CallOutcome): Promise<CallOutcome> {
		const result = scrubbedResult(settled.result);
		const outcome =
			result === settled.result ? settled : { ...settled, result };
		const { toolCall } = outcome;
		this.outcomes.set(toolCall.id, outcome);
		this.ended.add(toolCall.id);
		await this.agent.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result: outcome.result,
			isError: outcome.isError,
			...(outcome.durationMs === undefined
				? {}
				: { durationMs: outcome.durationMs }),
		});
		this.messages.set(toolCall.id, resultMessage(outcome));
		return outcome;
	}
}

/** The text pi's loop gives a call cut off by the output token limit. */
export function truncatedCallText(name: string): string {
	return `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
}

/**
 * A result with every credential in its text, details and structured
 * answer replaced by words saying what kind it was; the same object when
 * it held none. A picture is handed on as it is, as the interceptor does.
 */
function scrubbedResult(result: AgentToolResult): AgentToolResult {
	let found = false;
	const content = result.content?.map((part): ContentBlock => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		const { text, kinds } = scrubSecrets(part.text);
		if (kinds.length === 0) return part;
		found = true;
		return { ...part, text };
	});
	const details = scrubDeep(result.details);
	const structured = scrubDeep(result.structuredContent);
	if (!found && details.kinds.length === 0 && structured.kinds.length === 0)
		return result;
	return {
		...result,
		...(content === undefined ? {} : { content }),
		...(details.kinds.length === 0 ? {} : { details: details.value }),
		...(structured.kinds.length === 0
			? {}
			: { structuredContent: structured.value }),
	};
}

function prepareArguments(tool: AgentTool, toolCall: ToolCall): ToolCall {
	if (!tool.prepareArguments) return toolCall;
	const prepared = tool.prepareArguments(toolCall.arguments);
	if (prepared === toolCall.arguments) return toolCall;
	return { ...toolCall, arguments: prepared as Record<string, unknown> };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
