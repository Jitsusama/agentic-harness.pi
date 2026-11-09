/**
 * The parts of pi-durable the engine drives, declared here for the same
 * reason as pi-types.ts: the host loads pi-durable from its own install.
 * Each names only what the engine uses.
 */
import type {
	AgentMessage,
	ContentBlock,
	Model,
	ProviderStream,
} from "./pi-types.ts";

/** chord's context, which every durable call takes. */
export interface DurableContext {
	readonly abortSignal?: AbortSignal;
	readonly [field: string]: unknown;
}

/** An entry on a durable conversation's transcript. */
export interface EntryRecord {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly AgentMessage[];
	readonly data?: unknown;
}

/** One page of entries. */
export interface EntryPage {
	readonly items: readonly EntryRecord[];
	readonly next?: unknown;
}

/** Where a scan of entries starts and which way it runs. */
export interface EntryQuery {
	readonly minEntryId?: number;
	readonly maxEntryId?: number;
	readonly order?: "ascending" | "descending";
}

/** A submission's record once it settles. */
export interface SettledSubmission {
	readonly status: "done" | "unanswered";
	readonly reason?: string;
}

/** A durably admitted submission. */
export interface Submission {
	readonly id: number;
	wait(context: DurableContext): Promise<SettledSubmission>;
}

/** A submission as the host drafts it. */
export type SubmissionDraft = { readonly requestId?: string } & (
	| {
			readonly type: "input";
			readonly content: string | readonly ContentBlock[];
			readonly whenBusy?: "steer" | "followUp" | "reject";
			readonly whenIdle?: "reject";
			readonly entry?: { readonly kind: string; readonly data?: unknown };
	  }
	| { readonly type: "continue" }
);

/** A durable conversation. */
export interface Conversation {
	readonly id: number;
	configure(
		change: { readonly model?: { provider: string; modelId: string } },
		context: DurableContext,
	): Promise<void>;
	submit(
		submission: SubmissionDraft,
		context: DurableContext,
	): Promise<Submission>;
	entries(
		query: EntryQuery,
		limit: number,
		cursor: unknown,
		context: DurableContext,
	): Promise<EntryPage>;
	abort(context: DurableContext): Promise<void>;
	waitForIdle(context: DurableContext): Promise<void>;
}

/** A durable store's harness. */
export interface Harness {
	root(
		context: DurableContext,
		options?: {
			readonly agent?: {
				readonly model?: { provider: string; modelId: string };
			};
		},
	): Promise<Conversation>;
	resume(): void;
	abortSubmission(id: number, context: DurableContext): Promise<string>;
	close(context: DurableContext): Promise<void>;
}

/** What a hook may read. */
export interface HookApi {
	readonly taskId: number;
	readonly conversationId: number;
}

/** What a tool's execution may use. */
export interface ToolExecutionApi {
	readonly callId: string;
	readonly conversationId: number;
}

/** A tool's result, as durable stores it. */
export interface ToolExecutionResult {
	readonly output?: readonly ContentBlock[];
	readonly isError?: boolean;
	readonly details?: unknown;
	readonly usage?: unknown;
	readonly control?: { readonly terminate?: boolean };
}

/** A tool installed in a durable registry. */
export interface ToolRegistration {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
	readonly replay: "safe" | "unsafe";
	readonly executionMode?: "parallel" | "sequential";
	execute(
		args: unknown,
		api: ToolExecutionApi,
		context: DurableContext,
	): Promise<ToolExecutionResult>;
}

/** The generation hooks the engine installs. */
export interface GenerationHooks {
	beforeRequest(
		request: { readonly messages: readonly AgentMessage[] },
		api: HookApi,
		context: DurableContext,
	): Promise<{ readonly messages: readonly AgentMessage[] } | undefined>;
	onCommittedTurn(
		turn: { readonly assistant: number; readonly results: readonly number[] },
		api: HookApi,
		context: DurableContext,
	): Promise<{ readonly action: "end" | "continue" }>;
}

/** A named bundle of tools and hooks. */
export interface Extension {
	readonly name: string;
	readonly tools?: readonly ToolRegistration[];
	readonly hooks?: readonly unknown[];
}

/** The registry a harness reads its extensions from. */
export interface Registry {
	install(extension: Extension): void;
}

/** The run policy the engine gives each conversation's harness. */
export interface HarnessSettings {
	readonly retry: { readonly enabled: false };
	readonly compaction: { readonly enabled: false };
	readonly toolExecution: "parallel" | "sequential";
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly afterFailedRun: "keep";
}

/** The models a harness requests through. */
export interface DurableModels {
	getModel(provider: string, id: string): Model | undefined;
	streamSimple(
		model: Model,
		context: { readonly messages: readonly AgentMessage[] },
		options?: Record<string, unknown>,
	): ProviderStream;
}
