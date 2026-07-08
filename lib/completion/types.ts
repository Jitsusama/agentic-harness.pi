/**
 * Local type surface for the side-completion boundary.
 *
 * The standalone `completeSimple` helper moved from the pi-ai
 * package root into its `/compat` subpath in pi 0.80.x. This
 * package's typecheck resolves an older pi-ai where that subpath
 * does not exist, so the runtime call is reached through a
 * dynamic import and typed here rather than imported statically.
 * These shapes mirror the runtime contract the probe verified.
 */

import type { ModelRef } from "./resolve.js";

/** A per-bucket money breakdown returned by a completion. */
export interface CompletionCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** Token usage and cost returned by a completion. */
export interface CompletionUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: CompletionCost;
}

/** One message in a completion context. */
export interface CompletionMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
	readonly timestamp: number;
}

/** The context a completion runs against. */
export interface CompletionContext {
	readonly systemPrompt: string;
	readonly messages: CompletionMessage[];
}

/** Request auth resolved from the model registry. */
export interface CompletionAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
}

/** The assistant message a completion returns. */
export interface CompletionMessageResult {
	readonly content: Array<{ type: string; text?: string }>;
	readonly usage: CompletionUsage;
	readonly stopReason: string;
	readonly errorMessage?: string;
}

/** The `completeSimple` function as this package calls it. */
export type CompleteSimple = (
	model: ModelRef,
	context: CompletionContext,
	options: CompletionAuth & { signal?: AbortSignal },
) => Promise<CompletionMessageResult>;

/** The compat module shape reached by dynamic import. */
export interface CompatModule {
	readonly completeSimple: CompleteSimple;
}

/**
 * The registry surface a side completion needs. Structurally
 * satisfied by pi's `ctx.modelRegistry`, kept minimal so the
 * helper is testable with a fake.
 */
export interface CompletionRegistry {
	getAvailable(): ModelRef[];
	find(provider: string, model: string): ModelRef | undefined;
	getApiKeyAndHeaders(model: ModelRef): Promise<
		| {
				ok: true;
				apiKey?: string;
				headers?: Record<string, string>;
				env?: Record<string, string>;
		  }
		| { ok: false; error: string }
	>;
}
