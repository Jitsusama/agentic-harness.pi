/**
 * Shared test fixtures and constructors.
 *
 * Production types in pr-workflow are intentionally
 * strict (every field required when the data has a
 * stable wire representation). Tests want to focus on
 * one field at a time without restating every other
 * field on every fixture. These helpers fill the
 * boilerplate so test bodies show the field under test
 * with the surrounding shape implied.
 *
 * Each helper takes a `Partial<>` of the target type
 * and merges over a sane default. Add new defaults as
 * production types grow; never widen production types
 * just to make tests terser.
 */

import { expect } from "vitest";
import type { PrMetadata } from "../../../extensions/pr-workflow/fetch.js";
import type { ReviewerUsage } from "../../../extensions/pr-workflow/reviewer.js";
import type { DiffHunk, DiffLine } from "../../../lib/internal/github/diff.js";

/** Build a complete `PrMetadata` from partial overrides. */
export function prMetadata(overrides: Partial<PrMetadata> = {}): PrMetadata {
	return {
		title: "Test PR",
		author: "tester",
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/o/r/pull/1",
		body: "",
		base: { ref: "main", sha: "base-sha" },
		head: { ref: "feature", sha: "head-sha" },
		additions: 0,
		deletions: 0,
		changedFiles: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

/** Build a complete `ReviewerUsage` from partial overrides. */
export function reviewerUsage(
	tokens: Partial<ReviewerUsage["tokens"]> = {},
	cost: Partial<ReviewerUsage["cost"]> = {},
): ReviewerUsage {
	return {
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...tokens,
		},
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...cost,
		},
	};
}

/** Build a complete `DiffHunk` from partial overrides. */
export function diffHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
	return {
		header: "@@ -1,0 +1,1 @@",
		oldStart: 1,
		oldCount: 0,
		newStart: 1,
		newCount: 1,
		lines: [],
		...overrides,
	};
}

/** Build a complete `DiffLine` from partial overrides. */
export function diffLine(overrides: Partial<DiffLine> = {}): DiffLine {
	return {
		type: "added",
		content: "x",
		oldLineNumber: null,
		newLineNumber: 1,
		...overrides,
	};
}

/**
 * Narrow a discriminated `{ ok: true } | { ok: false;
 * error: string }` result to its failure case. Fails
 * the test loudly if the result was actually a success.
 * Use to assert error contents without a manual
 * narrowing dance in every test body.
 */
export function expectFailure<T extends { ok: boolean }>(
	result: T,
): Extract<T, { ok: false }> {
	expect(result.ok).toBe(false);
	if (result.ok) {
		throw new Error("expectFailure: result was ok: true");
	}
	return result as Extract<T, { ok: false }>;
}
