/**
 * Side completions: run a one-shot completion against a model
 * from the registry, off the agent's own loop.
 *
 * The advisor and correction capture both need a cheap second
 * model to distill or judge without disturbing the doer. The
 * mechanism (resolve a model and its auth, run one completion or a
 * bounded tool-using loop) takes the model call as an injected
 * `complete` function, which keeps it testable without a model.
 * This barrel supplies pi's own: it resolves `completeSimple` from
 * pi-ai's compat subpath, so callers make the two-argument call.
 *
 * The compat subpath holds `completeSimple` in pi 0.80.x. The
 * specifier is held in a variable so the typechecker treats the
 * dynamic import as untyped rather than trying to resolve a
 * subpath the older typecheck dependency lacks.
 */

import {
	type InvestigationRequest,
	type InvestigationResult,
	runInvestigation as runInvestigationWith,
} from "./investigate.ts";
import {
	runSideCompletion as runSideCompletionWith,
	type SideCompletionRequest,
	type SideCompletionResult,
} from "./side.ts";
import type { CompatModule, CompletionRegistry } from "./types.ts";

export type {
	InvestigationRequest,
	InvestigationResult,
	LoopTool,
} from "./investigate.ts";
export {
	isModelUnreachable,
	looksLikeGlm,
	type ModelRef,
	type ModelTarget,
	pickModel,
	rankModels,
} from "./resolve.ts";
export type { SideCompletionRequest, SideCompletionResult } from "./side.ts";
export type {
	CompatModule,
	CompleteSimple,
	CompletionHeaders,
	CompletionMessage,
	CompletionRegistry,
} from "./types.ts";

const COMPAT_SPECIFIER = "@earendil-works/pi-ai/compat";

async function completeSimple(
	...args: Parameters<CompatModule["completeSimple"]>
): ReturnType<CompatModule["completeSimple"]> {
	const { completeSimple: run } = (await import(
		COMPAT_SPECIFIER
	)) as CompatModule;
	return run(...args);
}

/** Run one completion off the agent's loop, through pi's own model call. */
export async function runSideCompletion(
	registry: CompletionRegistry,
	request: SideCompletionRequest,
): Promise<SideCompletionResult> {
	return runSideCompletionWith(registry, request, completeSimple);
}

/** Run a bounded tool-using loop off the agent's loop, through pi's own model call. */
export async function runInvestigation(
	registry: CompletionRegistry,
	request: InvestigationRequest,
): Promise<InvestigationResult> {
	return runInvestigationWith(registry, request, completeSimple);
}
