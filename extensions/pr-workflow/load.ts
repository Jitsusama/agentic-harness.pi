/**
 * Load a PR into the workflow session.
 *
 * Resolves a user-supplied reference (URL, short form or bare
 * number with a default repo) into a `PRReference` and engages
 * the workflow. No network calls happen here; metadata fetch
 * is a follow-up capability layered on top of this module.
 */

import { parsePRReference } from "../../lib/internal/github/pr-reference.js";
import type { ChangeRef } from "../../lib/review/index.js";
import { changeFromGitHubView, viewOf } from "./reference.js";
import type { CouncilState, PrRunSnapshot, PrWorkflowState } from "./state.js";

/**
 * Inputs for `loadPr`. `now` is injected so tests can pin the
 * timestamp; production callers omit it and get `Date.now()`.
 */
export interface LoadPrInput {
	/** User-supplied PR reference. */
	input: string;
	/** Owner / repo to fall back to when input is a bare number. */
	defaultRepo?: { owner: string; repo: string };
	/**
	 * The change, already resolved by the substrate.
	 *
	 * Supplied whenever the caller could reach a provider, which
	 * is how a change on a system this module cannot parse gets
	 * loaded at all. Without it the input is parsed as a GitHub
	 * reference, which is the only shape this module knows.
	 */
	change?: ChangeRef;
	/** Clock for the load timestamp. Defaults to `() => new Date()`. */
	now?: () => Date;
}

/** Outcome of a `loadPr` call. */
export type LoadPrResult = { ok: true } | { ok: false; error: string };

/**
 * Parse the reference and mutate `state` in place on success.
 * Returns an error result without touching `state` on failure.
 */
export function loadPr(
	state: PrWorkflowState,
	input: LoadPrInput,
): LoadPrResult {
	// A change the substrate already resolved needs no parsing: it
	// arrives knowing its own system, which is the only way one
	// this module cannot spell gets loaded at all.
	const reference = input.change
		? viewOf(input.change)
		: parsePRReference(
				input.input,
				input.defaultRepo?.owner,
				input.defaultRepo?.repo,
			);

	if (reference === null) {
		return {
			ok: false,
			error:
				`Could not parse "${input.input}" as a PR reference. ` +
				"Expected a GitHub URL (https://github.com/owner/repo/pull/N), " +
				"a Graphite URL (https://app.graphite.com/github/pr/owner/repo/N), " +
				"a short form (owner/repo#N), or a bare number with the " +
				"workflow already loaded in a repo checkout.",
		};
	}

	const previousReference = state.pr?.reference ?? null;
	const previousNumber = previousReference?.number ?? null;
	if (
		previousNumber !== null &&
		previousNumber !== reference.number &&
		hasReviewState(state.council)
	) {
		state.stackRuns.set(previousNumber, snapshot(state.council));
	}

	const restored = state.stackRuns.get(reference.number) ?? null;
	if (restored) {
		state.council.lastRun = restored.lastRun;
		state.council.lastJudge = restored.lastJudge;
		state.council.lastCritique = restored.lastCritique;
		state.council.decisions = new Map(restored.decisions);
		state.stackRuns.delete(reference.number);
	} else if (previousNumber !== reference.number) {
		state.council.lastRun = null;
		state.council.lastJudge = null;
		state.council.lastCritique = null;
		state.council.decisions = new Map();
	}

	const clock = input.now ?? (() => new Date());
	state.active = true;
	state.pr = {
		// The resolved change when there is one, and otherwise the
		// GitHub change the parse just recognized. Never a guess.
		change: input.change ?? changeFromGitHubView(reference),
		reference,
		loadedAt: clock().toISOString(),
		metadata: null,
		files: null,
		stack: null,
	};
	if (!sameReference(previousReference, reference)) {
		state.threads = null;
		state.threadContextWarning = null;
	}
	return { ok: true };
}

/**
 * True when the council has anything worth remembering
 * for the PR currently being navigated away from — a
 * run, a judge result, a critique result, or a user
 * decision.
 */
function sameReference(
	left: NonNullable<PrWorkflowState["pr"]>["reference"] | null,
	right: NonNullable<PrWorkflowState["pr"]>["reference"],
): boolean {
	return (
		left !== null &&
		left.owner === right.owner &&
		left.repo === right.repo &&
		left.number === right.number
	);
}

function hasReviewState(council: CouncilState): boolean {
	return (
		council.lastRun !== null ||
		council.lastJudge !== null ||
		council.lastCritique !== null ||
		council.decisions.size > 0
	);
}

/** Build a `PrRunSnapshot` from the current council state. */
function snapshot(council: CouncilState): PrRunSnapshot {
	return {
		lastRun: council.lastRun,
		lastJudge: council.lastJudge,
		lastCritique: council.lastCritique,
		decisions: new Map(council.decisions),
	};
}
