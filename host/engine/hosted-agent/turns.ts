/**
 * pi's turns around durable's requests: the steps pi's loop takes before
 * each request, the end of a turn durable committed and what follows it,
 * and a turn a failed or aborted request ends, each shown to pi as its
 * loop shows them.
 */
import { pairToolResults } from "../paired-results.ts";
import type { PiLibrary } from "../pi-library.ts";
import type {
	AgentEvent,
	AgentMessage,
	AgentOptions,
	AssistantMessage,
	CompletedTurn,
	ProviderStream,
	ToolResultMessage,
	TurnUpdate,
} from "../pi-types.ts";
import type { MessageQueue } from "../queue.ts";
import {
	errorResult,
	resultMessage,
	terminates,
	toolCalls,
	truncatedCallText,
} from "../tool-round.ts";
import {
	isAssistant,
	lastOfRole,
	resultOf,
	resultsOf,
} from "./messages.ts";
import { applyModel, type Run } from "./run.ts";
import { declareToolChanges } from "./tool-changes.ts";
import type { Transcript } from "./transcript.ts";

/** The agent's hooks a turn calls, read as each turn runs, since pi's session sets them after. */
export interface TurnHooks {
	readonly convertToLlm: NonNullable<AgentOptions["convertToLlm"]>;
	readonly transformContext: AgentOptions["transformContext"];
	readonly finishTurn: AgentOptions["finishTurn"];
	readonly prepareRequest: AgentOptions["prepareRequest"];
	readonly prepareNextTurn: AgentOptions["prepareNextTurn"];
	readonly prepareNextTurnWithContext: AgentOptions["prepareNextTurnWithContext"];
}

/** What a turn shows pi through, and what it asks of the agent. */
export interface TurnSide {
	readonly library: PiLibrary;
	readonly transcript: Transcript;
	readonly steering: MessageQueue;
	readonly followUp: MessageQueue;
	emit(event: AgentEvent): Promise<void>;
	stream(options: Record<string, unknown>): ProviderStream;
	/** Settles once every queued word begun to be given to durable is in. */
	admitted(): Promise<unknown>;
}

/** pi's turns, taken as pi's loop takes them, around what durable does. */
export class Turns {
	private readonly hooks: TurnHooks;
	private readonly side: TurnSide;

	constructor(hooks: TurnHooks, side: TurnSide) {
		this.hooks = hooks;
		this.side = side;
	}

	/** An error or aborted answer ends the turn and the run, as pi's loop does. */
	async endFailedTurn(run: Run, message: AssistantMessage): Promise<void> {
		const answer = run.answer;
		run.answer = undefined;
		if (!answer?.started)
			await this.side.emit({ type: "message_start", message: { ...message } });
		await this.side.emit({ type: "message_end", message });
		run.newMessages.push(message);
		const turn: CompletedTurn = {
			message,
			toolResults: [],
			context: run.context,
			newMessages: run.newMessages,
		};
		run.lastCompletedTurn = turn;
		await this.hooks.finishTurn?.(turn, run.controller.signal);
		await this.side.emit({ type: "turn_end", message, toolResults: [] });
		await this.side.emit({ type: "agent_end", messages: run.newMessages });
		run.ended = true;
	}

	/** Close a round whose run was aborted after its tools, as pi's loop would on its next aborted request. */
	async closeRound(run: Run): Promise<void> {
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
		await this.hooks.finishTurn?.(turn, run.controller.signal);
		await this.side.emit({
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
		const stream = this.side.stream({ signal: run.controller.signal });
		for await (const _event of stream) {
			// Each event is shown to pi by the tee as it passes.
		}
		await stream.result();
		const answer = run.answer?.message;
		if (!answer)
			throw new Error("pi's stream ended an aborted request without an answer");
		await this.endFailedTurn(run, answer);
	}

	/** pi's steps before a request: the next turn, what it places, prepareRequest and the context hooks. */
	async prepareTurnRequest(run: Run): Promise<readonly AgentMessage[]> {
		const prepared = run.lastCompletedTurn ? await this.nextTurn(run) : [];
		const placed = run.placed.splice(0);
		for (const message of declareToolChanges(this.side.library, run.context, [
			...prepared,
			...placed,
		])) {
			await this.side.transcript.show(run, message);
		}
		const update = await this.hooks.prepareRequest?.(
			{
				context: run.context,
				model: run.model,
				thinkingLevel: run.reasoning ?? "off",
			},
			run.controller.signal,
		);
		this.applyUpdate(run, update);
		let messages = run.context.messages;
		if (this.hooks.transformContext)
			messages = await this.hooks.transformContext(
				messages,
				run.controller.signal,
			);
		const converted = pairToolResults(await this.hooks.convertToLlm(messages));
		const normalized = this.side.library.normalizeContext({
			messages: converted,
		});
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
			(this.hooks.prepareNextTurnWithContext || this.hooks.prepareNextTurn)
		) {
			const update = this.hooks.prepareNextTurnWithContext
				? await this.hooks.prepareNextTurnWithContext(
						completed,
						run.controller.signal,
					)
				: await this.hooks.prepareNextTurn?.(run.controller.signal);
			if (update) {
				run.context = update.context ?? run.context;
				prepared = [...(update.messages ?? [])];
				applyModel(run, update);
			}
		}
		await this.side.emit({ type: "turn_start" });
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
	async committedTurn(
		run: Run,
		committed: { readonly assistant: number },
	): Promise<{
		readonly action: "end" | "continue";
	}> {
		await this.side.transcript.mirror(run, { showResults: true });
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
			message = await this.side.transcript.answerShownBefore(
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
		const decision = await this.hooks.finishTurn?.(turn, run.controller.signal);
		await this.side.emit({ type: "turn_end", message, toolResults });
		if (decision?.action === "end") {
			run.endDecided = true;
			return { action: "end" };
		}
		const moreTools =
			toolResults.length > 0 &&
			!(round ? terminates([...round.outcomes.values()]) : false);
		await this.side.admitted();
		if (moreTools || this.side.steering.hasItems())
			return { action: "continue" };
		// pi runs follow-ups before honouring a continue; durable places them when this turn ends.
		if (decision?.action === "continue" && !this.side.followUp.hasItems())
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
			await this.side.emit({
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
			await this.side.emit({
				type: "tool_execution_end",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				result: outcome.result,
				isError: true,
			});
			const shown = resultMessage(outcome);
			await this.side.transcript.show(run, shown);
			results.push(shown);
		}
		return results;
	}
}
