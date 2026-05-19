/**
 * Provider-agnostic finding data model.
 *
 * A finding is an internal observation about code at a
 * location. It may or may not get promoted into a review
 * thread; pi keeps the working list in memory and the user
 * decides what posts.
 *
 * This module defines the types only. Production of findings
 * (council, agent, import) and consumption (review draft,
 * thread promotion) live in other modules.
 *
 * The shape mirrors design doc 11-review-data-model.md.
 * Optional fields exist so early commits can produce
 * findings with just the essentials and later commits can
 * fill in agreement, user position, promotion details.
 */

import type { ReviewerUsage } from "./reviewer.js";

/** A location in the PR. */
export type FindingLocation =
	| {
			readonly kind: "line";
			readonly file: string;
			readonly start: number;
			readonly end: number;
			readonly side: "old" | "new" | "both";
	  }
	| { readonly kind: "file"; readonly file: string }
	| { readonly kind: "global" };

/** Conventional Comments labels. */
export type ConventionalLabel =
	| "praise"
	| "nitpick"
	| "suggestion"
	| "issue"
	| "todo"
	| "question"
	| "thought"
	| "chore"
	| "note"
	| "typo"
	| "polish"
	| "quibble";

/** Where the finding came from. */
export type FindingOrigin =
	| { readonly kind: "agent" }
	| { readonly kind: "user"; readonly note?: string }
	| {
			readonly kind: "council";
			readonly runId: string;
			readonly reviewerId: string;
	  }
	| {
			readonly kind: "judge";
			readonly runId: string;
			readonly judgeReviewerId: string;
	  };

/** Lifecycle state. */
export type FindingState = "draft" | "promoted" | "dismissed";

/** Severity. Orthogonal to label/decorations. */
export type FindingSeverity = "critical" | "medium" | "minor";

/**
 * Cross-reviewer agreement metadata attached by the judge
 * round. `raisedBy` lists the reviewer ids that surfaced
 * the same finding; `sourceFindingIds` ties the
 * consolidated finding back to the round-1 ids it merges.
 */
export interface FindingAgreement {
	readonly raisedBy: readonly string[];
	readonly sourceFindingIds: readonly number[];
}

/** A single observation. */
export interface Finding {
	readonly id: number;
	readonly location: FindingLocation;
	readonly label: ConventionalLabel;
	readonly decorations: readonly string[];
	readonly subject: string;
	readonly discussion: string;
	readonly category: "file" | "title" | "scope";
	readonly severity?: FindingSeverity;
	readonly confidence?: number;
	readonly origin: FindingOrigin;
	readonly state: FindingState;
	/** Cross-reviewer agreement; only set on judge output. */
	readonly agreement?: FindingAgreement;
}

/** One reviewer's output from a single round. */
export interface ReviewerOutput {
	readonly reviewerId: string;
	readonly findings: Finding[];
	/** Parse warnings, model errors, anything noteworthy. */
	readonly warnings: string[];
	/**
	 * Token + cost totals for this reviewer's subagent
	 * run. `undefined` when the dispatcher didn't surface
	 * usage (older pi, fake runner, crashed dispatch).
	 */
	readonly usage?: ReviewerUsage;
}

/** A council run: the unit of state for a council invocation. */
export interface CouncilRun {
	readonly id: string;
	readonly startedAt: string;
	readonly target: { readonly kind: "diff"; readonly prNumber: number };
	readonly reviewerOutputs: ReviewerOutput[];
	/**
	 * Path of the worktree the reviewers ran against.
	 * Subsequent rounds (judge, critique, fix) reuse the
	 * same worktree so file context stays consistent.
	 */
	readonly worktreePath: string;
}
