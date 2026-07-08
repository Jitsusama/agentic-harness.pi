/**
 * Run a one-shot side completion against a model from the
 * registry, without touching the agent's own loop.
 *
 * This is the mechanism the advisor and correction capture are
 * built on: resolve a model and its request auth from the
 * registry, then run the standalone `completeSimple` against it.
 * The result is a plain value with the text, usage and outcome,
 * so callers never see the underlying message shape.
 */

import { type ModelRef, pickModel } from "./resolve.js";
import type {
	CompatModule,
	CompletionMessage,
	CompletionRegistry,
	CompletionUsage,
} from "./types.js";

/** What to complete: the target model, a system prompt and turns. */
export interface SideCompletionRequest {
	/** Explicit provider, when targeting a specific model. */
	readonly provider?: string;
	/** Explicit model id, when targeting a specific model. */
	readonly model?: string;
	/** System prompt for the completion. */
	readonly systemPrompt: string;
	/** A single user prompt, or a full message list. */
	readonly prompt?: string;
	readonly messages?: CompletionMessage[];
	/** The caller's current model, used as a last-resort target. */
	readonly current?: ModelRef;
	readonly signal?: AbortSignal;
}

/** The outcome of a side completion. */
export interface SideCompletionResult {
	readonly ok: boolean;
	readonly text: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage?: CompletionUsage;
	readonly stopReason?: string;
	readonly error?: string;
}

/**
 * The compat subpath holding `completeSimple` in pi 0.80.x. The
 * specifier is held in a variable so the typechecker treats the
 * dynamic import as untyped rather than trying to resolve a
 * subpath the older typecheck dependency lacks.
 */
const COMPAT_SPECIFIER = "@mariozechner/pi-ai/compat";

/** Pull the plain text out of a completion's content blocks. */
function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

/**
 * Resolve a model and its auth from `registry`, run one
 * completion and return the text and usage. Every failure path
 * (no model, no auth, a throwing call) returns `ok: false` with a
 * message rather than throwing, so a caller on a hot path can
 * degrade quietly.
 */
export async function runSideCompletion(
	registry: CompletionRegistry,
	request: SideCompletionRequest,
): Promise<SideCompletionResult> {
	const available = registry.getAvailable();
	const model = pickModel(
		available,
		request.current,
		{ provider: request.provider, model: request.model },
		(p, m) => registry.find(p, m),
	);
	if (!model) {
		return { ok: false, text: "", error: "no model available" };
	}

	let auth: Awaited<ReturnType<CompletionRegistry["getApiKeyAndHeaders"]>>;
	try {
		auth = await registry.getApiKeyAndHeaders(model);
	} catch (err) {
		return {
			ok: false,
			text: "",
			provider: model.provider,
			model: model.id,
			error: `auth resolution threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!auth.ok) {
		return {
			ok: false,
			text: "",
			provider: model.provider,
			model: model.id,
			error: `auth not configured: ${auth.error}`,
		};
	}

	const messages: CompletionMessage[] = request.messages ?? [
		{
			role: "user",
			content: request.prompt ?? "",
			timestamp: Date.now(),
		},
	];

	try {
		const { completeSimple } = (await import(COMPAT_SPECIFIER)) as CompatModule;
		const result = await completeSimple(
			model,
			{ systemPrompt: request.systemPrompt, messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: request.signal,
			},
		);
		return {
			ok: result.stopReason !== "error",
			text: textOf(result.content),
			provider: model.provider,
			model: model.id,
			usage: result.usage,
			stopReason: result.stopReason,
			error: result.errorMessage,
		};
	} catch (err) {
		return {
			ok: false,
			text: "",
			provider: model.provider,
			model: model.id,
			error: `completion threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
