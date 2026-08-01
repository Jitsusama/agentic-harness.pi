/**
 * Pointing a stack's changes back at what they now sit on.
 *
 * A local restack moves branches. It does not touch the changes those
 * branches are proposed as, so afterwards each one still claims to
 * merge into whatever it targeted when it went up. On a stack whose
 * bottom has landed, that is a change targeting a branch nobody is
 * merging any more, and the diff it shows is against the wrong thing.
 *
 * Whose job it is to fix that differs by backend, which is what
 * deferred this the first time. On one, retargeting is per change and
 * the caller walks the stack doing it. On another it is a single stack
 * operation, because the backend holds the stack itself and moving one
 * change without the others would leave its own model inconsistent.
 *
 * So the substrate does what it does for a diff: implement the general
 * case over the parts every provider has, and stand aside where a
 * provider says it owns the whole operation. The generic walk is not a
 * lesser version of the native one; for a backend that has no notion
 * of a stack it is the only version there is, and it is right there.
 */

import type { AuthoringFacet } from "./provider.js";
import type { Stack } from "./stack.js";

/** One change that should point somewhere else, and where. */
export interface Retarget {
	/** The change to move, by the ref its node names. */
	ref: string;
	/** What it targets now. */
	from: string;
	/** What it should target. */
	to: string;
}

/** What a retarget pass would do, or why it would do nothing. */
export interface RetargetPlan {
	/** The moves, in the order they should happen. */
	moves: Retarget[];
	/** Nodes deliberately left alone, and the reason for each. */
	skipped: { ref: string; why: string }[];
}

/**
 * Which changes in a stack point at the wrong base, and where they go.
 *
 * Roots are excluded rather than pointed at the trunk. A root already
 * targets the trunk in the ordinary case, and where it does not, the
 * stack cannot say whether that is wrong: somebody may be proposing a
 * root against a release branch on purpose, and moving it to the trunk
 * would retarget a change nobody asked about onto a branch that asks a
 * different team to review it.
 */
export function retargetPlan(stack: Stack): RetargetPlan {
	const moves: Retarget[] = [];
	const skipped: { ref: string; why: string }[] = [];

	for (const node of stack.nodes) {
		if (node.proposal === undefined) {
			// Nothing to retarget. A branch with no change on it is a
			// perfectly ordinary part of a stack somebody has not put up
			// yet, so this is a fact rather than a problem.
			skipped.push({ ref: node.ref, why: "nothing is proposed on it" });
			continue;
		}
		if (node.parent === undefined) {
			skipped.push({
				ref: node.ref,
				why: "it is a root, so what it targets is not the stack's to decide",
			});
			continue;
		}

		const now = node.proposal.base;
		if (now === node.parent) continue;
		moves.push({ ref: node.ref, from: now, to: node.parent });
	}

	return { moves, skipped };
}

/** Whether a provider owns this operation, or the substrate walks it. */
export interface RetargetRoute {
	kind: "native" | "per-change";
	/** Said out loud, because which one ran changes what can go wrong. */
	why: string;
}

/**
 * Who should carry out a retarget, and why that is the right answer.
 *
 * Named rather than decided silently because the two fail differently
 * and a caller has to be able to report which happened. A native pass
 * either moves the stack or does not. A per-change walk can stop half
 * way, leaving some changes moved and some not, and somebody reading
 * "retarget failed" needs to know which of those they are looking at.
 */
export function retargetRoute(
	stacking: { restack?: unknown } | undefined,
	authoring: AuthoringFacet | undefined,
): RetargetRoute | { refusal: string } {
	if (stacking?.restack !== undefined) {
		return {
			kind: "native",
			why: "this backend holds the stack itself, so it moves as one",
		};
	}
	if (authoring?.edit !== undefined) {
		return {
			kind: "per-change",
			why: "this backend has no stack operation, so each change is moved in turn",
		};
	}
	return {
		refusal:
			"This backend can neither restack nor edit a change's base, so there is no way to retarget from here. Move the changes wherever they are hosted.",
	};
}
