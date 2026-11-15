/**
 * What the agent needs of the world around it: its conversation's durable
 * side, and pi's session where words it queues show as pending.
 */
import type {
	Conversation,
	DurableContext,
	GenerationHooks,
	Registry,
	RunFailure,
	ToolRegistration,
} from "../durable-types.ts";
import type { AssistantMessage } from "../pi-types.ts";

/** Show words as pending in pi's screen, as pi's session shows what it queued itself. */
export type ShowQueued = (text: string, mode: "steer" | "followUp") => void;

/** pi's session, as far as showing the agent's queued words needs it: a runtime before the seam lacks it. */
export interface QueueShowingSession {
	showQueued?: ShowQueued;
}

/** What the agent needs of its conversation's durable side. */
export interface DurableBinding {
	readonly conversation: Conversation;
	readonly registry: Registry;
	readonly context: DurableContext;
	abortSubmission(id: number): Promise<string>;
	/** Let durable carry on what it had in flight, once the agent can answer its hooks. */
	resume(): void;
	/** The newest run durable ended without an answer, as it committed it. */
	runFailure(): Promise<RunFailure | undefined>;
	/** Whether durable holds a run a restart cut off, to carry on once it resumes. */
	carrying(): Promise<boolean>;
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
