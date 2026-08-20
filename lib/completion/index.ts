/**
 * Side completions: run a one-shot completion against a model
 * from the registry, off the agent's own loop.
 *
 * The mechanism itself (resolve a model and its auth, run one
 * completion or a bounded tool-using loop) lives in
 * agentic-harness.core, which takes the actual model call as an
 * injected `complete` function rather than running one itself.
 * This module is the pi-specific half of that port: it resolves
 * `completeSimple` from pi-ai's compat subpath and wraps core's
 * functions so callers keep the two-argument call they had before
 * the port.
 *
 * The compat subpath holds `completeSimple` in pi 0.80.x. The
 * specifier is held in a variable so the typechecker treats the
 * dynamic import as untyped rather than trying to resolve a
 * subpath the older typecheck dependency lacks.
 */

import {
	type CompatModule,
	type CompletionRegistry,
	runInvestigation as coreRunInvestigation,
	runSideCompletion as coreRunSideCompletion,
	type InvestigationRequest,
	type InvestigationResult,
	type SideCompletionRequest,
	type SideCompletionResult,
} from "@jitsusama/agentic-harness.core/completion";

export type {
	CompletionMessage,
	CompletionRegistry,
	InvestigationRequest,
	InvestigationResult,
	LoopTool,
	SideCompletionRequest,
	SideCompletionResult,
} from "@jitsusama/agentic-harness.core/completion";
export {
	looksLikeGlm,
	type ModelRef,
	type ModelTarget,
	pickModel,
} from "@jitsusama/agentic-harness.core/completion";

const COMPAT_SPECIFIER = "@earendil-works/pi-ai/compat";

/** Resolve completeSimple from pi-ai's compat subpath, once per call. */
async function completeSimple(
	...args: Parameters<CompatModule["completeSimple"]>
): ReturnType<CompatModule["completeSimple"]> {
	const { completeSimple: run } = (await import(
		COMPAT_SPECIFIER
	)) as CompatModule;
	return run(...args);
}

/** Run a one-shot side completion, resolving pi's own completion backend. */
export async function runSideCompletion(
	registry: CompletionRegistry,
	request: SideCompletionRequest,
): Promise<SideCompletionResult> {
	return coreRunSideCompletion(registry, request, completeSimple);
}

/** Run a bounded, tool-using investigation, resolving pi's own completion backend. */
export async function runInvestigation(
	registry: CompletionRegistry,
	request: InvestigationRequest,
): Promise<InvestigationResult> {
	return coreRunInvestigation(registry, request, completeSimple);
}
