/**
 * The shapes of pi's agent and pi-durable the engine drives, declared here
 * rather than imported: the host loads both from its own install at start,
 * and this package depends on neither. Each type names only the fields the
 * engine reads or writes, so a field pi adds never breaks it and a field
 * pi removes fails a test that uses it.
 */

/** A content block of a message, as pi-ai types it. */
export interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly [field: string]: unknown;
}

/** A tool call inside an assistant message. */
export interface ToolCall {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** Any message on pi's transcript: user, assistant, tool result, system or an extension's own. */
export interface AgentMessage {
	readonly role: string;
	readonly timestamp?: number;
	readonly [field: string]: unknown;
}

/** A provider's answer. */
export interface AssistantMessage extends AgentMessage {
	readonly role: "assistant";
	readonly content: readonly ContentBlock[];
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	thinkingLevel?: string;
}

/** A tool's result, as the transcript holds it. */
export interface ToolResultMessage extends AgentMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly ContentBlock[];
	readonly isError: boolean;
}

/** A model, as pi-ai describes it. */
export interface Model {
	readonly id: string;
	readonly provider: string;
	readonly api: string;
	readonly [field: string]: unknown;
}

/** One event of a provider's stream. */
export interface ProviderEvent {
	readonly type: string;
	readonly partial?: AssistantMessage;
	readonly message?: AssistantMessage;
	readonly error?: AssistantMessage;
}

/** A provider's stream: its events, then its final message. */
export interface ProviderStream extends AsyncIterable<ProviderEvent> {
	result(): Promise<AssistantMessage>;
}

/** Options pi passes a stream function. */
export type StreamOptions = Record<string, unknown> & {
	readonly signal?: AbortSignal;
	readonly onPayload?: (payload: unknown, model: Model) => unknown;
};

/** pi's stream function. */
export type StreamFn = (
	model: Model,
	context: { readonly messages: readonly AgentMessage[] },
	options?: StreamOptions,
) => ProviderStream | Promise<ProviderStream>;

/** A tool's result, before it becomes a message. */
export interface AgentToolResult {
	readonly content?: readonly ContentBlock[];
	readonly details?: unknown;
	readonly usage?: unknown;
	readonly isError?: boolean;
	readonly structuredContent?: unknown;
	terminate?: boolean;
}

/** A tool the agent can run. */
export interface AgentTool {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: unknown;
	readonly executionMode?: "parallel" | "sequential";
	prepareArguments?(args: unknown): unknown;
	execute(
		toolCallId: string,
		args: never,
		signal: AbortSignal | undefined,
		onUpdate: (partial: AgentToolResult) => void,
	): Promise<AgentToolResult>;
}

/** The context a turn runs over. */
export interface AgentContext {
	messages: AgentMessage[];
	tools?: AgentTool[];
	readonly [field: string]: unknown;
}

/** A completed turn, as pi's finishTurn and prepareNextTurn see it. */
export interface CompletedTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
	readonly context: AgentContext;
	readonly newMessages: readonly AgentMessage[];
}

/** What prepareRequest and prepareNextTurn may change. */
export interface TurnUpdate {
	readonly context?: AgentContext;
	readonly messages?: readonly AgentMessage[];
	readonly model?: Model;
	readonly thinkingLevel?: string;
}

/** The agent's events, which AgentSession persists and extensions see. */
export type AgentEvent =
	| { readonly type: "agent_start" }
	| { readonly type: "agent_end"; readonly messages: readonly AgentMessage[] }
	| { readonly type: "turn_start" }
	| {
			readonly type: "turn_end";
			readonly message: AgentMessage;
			readonly toolResults: readonly ToolResultMessage[];
	  }
	| { readonly type: "message_start"; readonly message: AgentMessage }
	| {
			readonly type: "message_update";
			readonly message: AgentMessage;
			readonly assistantMessageEvent: ProviderEvent;
	  }
	| { readonly type: "message_end"; readonly message: AgentMessage }
	| {
			readonly type: "tool_execution_start";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: unknown;
	  }
	| {
			readonly type: "tool_execution_update";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: unknown;
			readonly partialResult: AgentToolResult;
	  }
	| {
			readonly type: "tool_execution_end";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly result: AgentToolResult;
			readonly isError: boolean;
			readonly durationMs?: number;
	  };

/** A listener the agent awaits, in subscription order. */
export type AgentListener = (
	event: AgentEvent,
	signal: AbortSignal,
) => Promise<void> | void;

/** How a queue drains: its first message, or all of them. */
export type QueueMode = "all" | "one-at-a-time";

/** Hook signatures pi's AgentSession installs on its agent. */
export interface AgentHooks {
	convertToLlm: (
		messages: AgentMessage[],
	) => AgentMessage[] | Promise<AgentMessage[]>;
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	onPayload?: (payload: unknown, model: Model) => unknown;
	onResponse?: (...args: never[]) => unknown;
	onProviderStreamEvent?: (...args: never[]) => unknown;
	beforeToolCall?: (
		context: {
			assistantMessage: AssistantMessage;
			toolCall: ToolCall;
			args: unknown;
			context: AgentContext;
		},
		signal?: AbortSignal,
	) => Promise<
		{ block?: boolean; reason?: string; terminate?: boolean } | undefined
	>;
	afterToolCall?: (
		context: {
			assistantMessage: AssistantMessage;
			toolCall: ToolCall;
			args: unknown;
			result: AgentToolResult;
			isError: boolean;
			context: AgentContext;
		},
		signal?: AbortSignal,
	) => Promise<
		| (Partial<AgentToolResult> & {
				readonly isError?: boolean;
				readonly structuredContent?: unknown;
		  })
		| undefined
	>;
	finishTurn?: (
		turn: CompletedTurn,
		signal?: AbortSignal,
	) =>
		| Promise<{ action: "end" | "continue" } | undefined>
		| { action: "end" | "continue" }
		| undefined;
	prepareRequest?: (
		request: { context: AgentContext; model: Model; thinkingLevel: string },
		signal?: AbortSignal,
	) => Promise<TurnUpdate | undefined> | TurnUpdate | undefined;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<TurnUpdate | undefined> | TurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: CompletedTurn,
		signal?: AbortSignal,
	) => Promise<TurnUpdate | undefined> | TurnUpdate | undefined;
}

/** The options pi gives the agent it builds, which the host's agent takes as they are. */
export interface AgentOptions extends Partial<AgentHooks> {
	readonly initialState?: {
		readonly systemPrompt?: string;
		readonly model?: Model;
		readonly thinkingLevel?: string;
		readonly tools?: readonly AgentTool[];
		readonly messages?: readonly AgentMessage[];
	};
	readonly streamFn: StreamFn;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	readonly sessionId?: string;
	readonly thinkingBudgets?: unknown;
	readonly transport?: string;
	readonly maxRetryDelayMs?: number;
	readonly toolExecution?: "parallel" | "sequential";
	readonly identity?: unknown;
}
