/**
 * A bounded, tool-using investigation against a side model.
 *
 * The advisor is a tool-using investigator, not a
 * transcript-only judge: it must be able to check a suspicion
 * against the workspace before it raises it. This runs a capped
 * loop where the model may call read-only tools, each result is
 * fed back into the same growing message list, and the loop ends
 * when the model answers with text or the step budget runs out.
 *
 * The message list is the caller's persistent context, so the
 * prefix caches turn to turn: the cost lever the advisor design
 * rests on. Usage is summed across every step of the loop.
 */

import { type ModelRef, pickModel } from "./resolve.js";
import type {
	CompatModule,
	CompletionRegistry,
	CompletionUsage,
} from "./types.js";

/** A read-only tool the investigation may call. */
export interface LoopTool {
	readonly name: string;
	readonly description: string;
	/** JSON schema for the tool's arguments. */
	readonly parameters: unknown;
	/** Run the tool and return its text result. */
	execute(args: Record<string, unknown>): Promise<string>;
}

/** What to investigate and with what budget. */
export interface InvestigationRequest {
	readonly provider?: string;
	readonly model?: string;
	readonly systemPrompt: string;
	/** The persistent message list; appended to in place-safe copies. */
	readonly messages: unknown[];
	readonly tools: LoopTool[];
	readonly current?: ModelRef;
	/** Maximum model round-trips before the loop stops. */
	readonly maxSteps: number;
	readonly signal?: AbortSignal;
}

/** The outcome of an investigation. */
export interface InvestigationResult {
	readonly ok: boolean;
	readonly text: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage: CompletionUsage;
	/** Model round-trips actually made. */
	readonly steps: number;
	/** The grown message list, for the caller to keep as context. */
	readonly messages: unknown[];
	readonly error?: string;
}

const COMPAT_SPECIFIER = "@mariozechner/pi-ai/compat";

const ZERO_USAGE: CompletionUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A content block that may be text or a tool call. */
interface Block {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

/** Sum two usage records bucket by bucket. */
function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/** Concatenate the text out of a content block list. */
function textOf(content: Block[]): string {
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
}

/** The tool calls present in a content block list. */
function toolCallsOf(content: Block[]): Block[] {
	return content.filter((b) => b.type === "toolCall" && b.name);
}

/**
 * Run a bounded investigation. Resolves a model and its auth,
 * then loops the model against `tools`, feeding each tool result
 * back in, until the model answers with text or `maxSteps` is
 * reached. Every failure path returns `ok: false` with a message
 * rather than throwing.
 */
export async function runInvestigation(
	registry: CompletionRegistry,
	request: InvestigationRequest,
): Promise<InvestigationResult> {
	const model = pickModel(
		registry.getAvailable(),
		request.current,
		{ provider: request.provider, model: request.model },
		(p, m) => registry.find(p, m),
	);
	if (!model) {
		return {
			ok: false,
			text: "",
			usage: ZERO_USAGE,
			steps: 0,
			messages: request.messages,
			error: "no model available",
		};
	}

	let auth: Awaited<ReturnType<CompletionRegistry["getApiKeyAndHeaders"]>>;
	try {
		auth = await registry.getApiKeyAndHeaders(model);
	} catch (err) {
		return failure(
			model,
			request.messages,
			`auth resolution threw: ${msg(err)}`,
		);
	}
	if (!auth.ok) {
		return failure(
			model,
			request.messages,
			`auth not configured: ${auth.error}`,
		);
	}

	const toolDefs = request.tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
	const byName = new Map(request.tools.map((t) => [t.name, t]));
	const messages = [...request.messages];
	let usage = ZERO_USAGE;

	let completeSimple: CompatModule["completeSimple"];
	try {
		({ completeSimple } = (await import(COMPAT_SPECIFIER)) as CompatModule);
	} catch (err) {
		return failure(model, messages, `compat import failed: ${msg(err)}`);
	}

	for (let step = 1; step <= request.maxSteps; step++) {
		let result: Awaited<ReturnType<CompatModule["completeSimple"]>>;
		try {
			// The persistent context holds raw runtime messages
			// (assistant turns and tool results), and tools ride
			// alongside; the compat surface is typed narrowly here, so
			// the whole context is cast to what completeSimple expects.
			const context = {
				systemPrompt: request.systemPrompt,
				messages,
				tools: toolDefs,
			} as unknown as Parameters<CompatModule["completeSimple"]>[1];
			result = await completeSimple(model, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: request.signal,
			});
		} catch (err) {
			return {
				ok: false,
				text: "",
				provider: model.provider,
				model: model.id,
				usage,
				steps: step - 1,
				messages,
				error: `completion threw: ${msg(err)}`,
			};
		}

		if (result.usage) usage = addUsage(usage, result.usage as CompletionUsage);
		const content = result.content as Block[];
		const calls = toolCallsOf(content);
		messages.push(result);

		if (calls.length === 0) {
			return {
				ok: result.stopReason !== "error",
				text: textOf(content),
				provider: model.provider,
				model: model.id,
				usage,
				steps: step,
				messages,
				error: result.errorMessage,
			};
		}

		for (const call of calls) {
			const tool = call.name ? byName.get(call.name) : undefined;
			let text: string;
			let isError = false;
			if (!tool) {
				text = `Unknown tool: ${call.name}`;
				isError = true;
			} else {
				try {
					text = await tool.execute(call.arguments ?? {});
				} catch (err) {
					text = `Tool ${call.name} failed: ${msg(err)}`;
					isError = true;
				}
			}
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError,
				timestamp: Date.now(),
			});
		}
	}

	// Budget exhausted with the model still calling tools: return
	// what we have as a non-error, so the caller can still use any
	// partial text and the loop never runs unbounded.
	return {
		ok: true,
		text: "",
		provider: model.provider,
		model: model.id,
		usage,
		steps: request.maxSteps,
		messages,
		error: "step budget exhausted",
	};
}

/** Human-readable message from an unknown thrown value. */
function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Build a uniform failure result. */
function failure(
	model: ModelRef,
	messages: unknown[],
	error: string,
): InvestigationResult {
	return {
		ok: false,
		text: "",
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		steps: 0,
		messages,
		error,
	};
}
