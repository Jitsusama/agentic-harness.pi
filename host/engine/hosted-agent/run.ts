/**
 * What one of the agent's runs holds while pi and durable both see it: the
 * request it made, the answer it streams, the round its tools run in and
 * what durable placed or committed that pi has yet to be shown. Also the
 * input entries the host writes and the empty usage a made-up answer has.
 */
import type { EntryRecord } from "../durable-types.ts";
import type {
	AgentContext,
	AgentMessage,
	AssistantMessage,
	CompletedTurn,
	Model,
	TurnUpdate,
} from "../pi-types.ts";
import type { ToolRound } from "../tool-round.ts";

/** Entry kinds the host writes its inputs as; durable keeps `pi.` for its own. */
export const INPUT_KINDS = {
	prompt: "host.prompt",
	steer: "host.steer",
	followUp: "host.follow-up",
} as const;

/** The data an input entry carries: pi's messages, as pi showed them. */
export interface InputData {
	readonly hostId: string;
	readonly messages: readonly AgentMessage[];
}

export interface Request {
	readonly model: Model;
	readonly reasoning: string | undefined;
	readonly messages: readonly AgentMessage[];
}

export interface Run {
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

/** The run under way, with the promise its end settles and what settles it. */
export interface ActiveRun {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly run: Run;
}

export const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function unansweredMessage(
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

export function applyModel(run: Run, update: TurnUpdate): void {
	run.model = update.model ?? run.model;
	if (update.thinkingLevel !== undefined) {
		run.reasoning =
			update.thinkingLevel === "off" ? undefined : update.thinkingLevel;
	}
}
