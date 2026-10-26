/**
 * Type surface for the side-completion boundary.
 *
 * `CompleteSimple` is the port: this package has no way to run a
 * model itself, so `runSideCompletion` and `runInvestigation` both
 * take one as a parameter and call it rather than reaching for a
 * concrete backend. `CompatModule` names the shape an adapter gets
 * back from dynamically importing its own completion function
 * (pi's is `@earendil-works/pi-ai/compat`'s `completeSimple`,
 * reached that way because pi's own typecheck dependency resolves
 * an older pi-ai where the subpath does not exist); a host with no
 * such subpath quirk can just pass a function of the same shape.
 */

import type { ModelRef } from "./resolve.ts";

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

/**
 * Request headers as pi's registry resolves them. A null value is
 * not an absent one: pi reads it as suppressing a provider default
 * header of the same name, so it has to reach the completion call
 * as it came rather than be dropped on the way.
 */
export type CompletionHeaders = Record<string, string | null>;

/** Request auth resolved from the model registry. */
export interface CompletionAuth {
	readonly apiKey?: string;
	readonly headers?: CompletionHeaders;
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
				headers?: CompletionHeaders;
				env?: Record<string, string>;
		  }
		| { ok: false; error: string }
	>;
}
