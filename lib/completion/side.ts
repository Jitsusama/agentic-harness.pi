/**
 * Run a one-shot side completion against a model from the
 * registry, without touching the agent's own loop.
 *
 * This is the mechanism the advisor and correction capture are
 * built on: resolve a model and its request auth from the
 * registry, then run the caller-supplied `complete` against it.
 * The result is a plain value with the text, usage and outcome,
 * so callers never see the underlying message shape.
 *
 * `complete` is a port: this module has no way to run a model
 * itself, and does not know or care what backend the caller's host
 * runs one through. pi's adapter resolves its own
 * `@earendil-works/pi-ai/compat` `completeSimple` and passes it in;
 * a different host supplies its own equivalent.
 */

import { isModelUnreachable, type ModelRef, rankModels } from "./resolve.ts";
import type {
	CompleteSimple,
	CompletionMessage,
	CompletionRegistry,
	CompletionUsage,
} from "./types.ts";

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

/** Pull the plain text out of a completion's content blocks. */
function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

/**
 * Resolve a model and its auth from `registry`, run one
 * completion through `complete` and return the text and usage.
 *
 * Models are tried in `rankModels` order. A model that cannot be
 * reached (no auth, or an error saying it is not there) gives way
 * to the next; any other outcome, success or failure, is the
 * answer. When every model gives way, the error names each one with
 * its reason. Every failure path returns `ok: false` with a message
 * rather than throwing, so a caller on a hot path can degrade
 * quietly.
 */
export async function runSideCompletion(
	registry: CompletionRegistry,
	request: SideCompletionRequest,
	complete: CompleteSimple,
): Promise<SideCompletionResult> {
	const candidates = rankModels(
		registry.getAvailable(),
		request.current,
		{ provider: request.provider, model: request.model },
		(p, m) => registry.find(p, m),
	);
	if (candidates.length === 0) {
		return { ok: false, text: "", error: "no model available" };
	}

	const messages: CompletionMessage[] = request.messages ?? [
		{
			role: "user",
			content: request.prompt ?? "",
			timestamp: Date.now(),
		},
	];

	const reasons: string[] = [];
	let last: SideCompletionResult = { ok: false, text: "" };
	for (const model of candidates) {
		// A cancelled caller wants no more models tried on its behalf.
		if (reasons.length > 0 && request.signal?.aborted) break;
		const attempt = await attemptOn(
			model,
			registry,
			request,
			messages,
			complete,
		);
		if (!attempt.unreachable) return attempt.result;
		last = attempt.result;
		reasons.push(`${model.provider}/${model.id}: ${attempt.result.error}`);
	}
	return { ...last, error: reasons.join("; ") };
}

/** One model's outcome, and whether it says to try the next. */
interface Attempt {
	readonly result: SideCompletionResult;
	readonly unreachable: boolean;
}

/** Resolve `model`'s auth and run the completion against it. */
async function attemptOn(
	model: ModelRef,
	registry: CompletionRegistry,
	request: SideCompletionRequest,
	messages: CompletionMessage[],
	complete: CompleteSimple,
): Promise<Attempt> {
	const failure = (error: string, unreachable: boolean): Attempt => ({
		result: {
			ok: false,
			text: "",
			provider: model.provider,
			model: model.id,
			error,
		},
		unreachable,
	});

	let auth: Awaited<ReturnType<CompletionRegistry["getApiKeyAndHeaders"]>>;
	try {
		auth = await registry.getApiKeyAndHeaders(model);
	} catch (err) {
		return failure(`auth resolution threw: ${messageOf(err)}`, true);
	}
	if (!auth.ok) {
		return failure(`auth not configured: ${auth.error}`, true);
	}

	try {
		const result = await complete(
			model,
			{ systemPrompt: request.systemPrompt, messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: request.signal,
			},
		);
		const failed = result.stopReason === "error";
		return {
			result: {
				ok: !failed,
				text: textOf(result.content),
				provider: model.provider,
				model: model.id,
				usage: result.usage,
				stopReason: result.stopReason,
				error: result.errorMessage,
			},
			unreachable: failed && isModelUnreachable(result.errorMessage ?? ""),
		};
	} catch (err) {
		const message = messageOf(err);
		return failure(`completion threw: ${message}`, isModelUnreachable(message));
	}
}

/** Human-readable message from an unknown thrown value. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
