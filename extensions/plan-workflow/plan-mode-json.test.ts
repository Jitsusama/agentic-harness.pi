/**
 * Demonstrates how the repos parameter description containing
 * embedded double-quotes causes LLM JSON generation failures,
 * and proves the fix (comma-separated string) eliminates them.
 *
 * Run:
 *   node --experimental-strip-types --test extensions/plan-workflow/plan-mode-json.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── helpers ──────────────────────────────────────────────

/** Mirrors what pi does: JSON.parse the tool call params string. */
function parseToolParams(json: string): Record<string, unknown> {
	return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Assert that parsing fails with a JSON error.
 */
function assertJsonParseError(json: string, label: string): void {
	assert.throws(
		() => parseToolParams(json),
		(err: unknown) => {
			const msg = (err as Error).message;
			return msg.includes("JSON") || msg.includes("Unexpected") || msg.includes("Expected");
		},
		`${label}: expected a JSON parse error but parsing succeeded`,
	);
}

/**
 * Mirrors the fixed execute() logic: split a comma-separated
 * string into an array of repo paths.
 */
function parseRepos(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	return raw.split(",").map((r) => r.trim()).filter(Boolean);
}

// ── OLD SCHEMA: Type.Array(Type.String()) ────────────────
// Description: 'Use "." for the current repo'
// These reproduce the failures the user saw.

describe("OLD schema: array of strings with quoted description", () => {
	describe("valid calls (baseline)", () => {
		it("activate without repos", () => {
			const params = parseToolParams('{"action":"activate"}');
			assert.equal(params.action, "activate");
			assert.equal(params.repos, undefined);
		});

		it("activate with repos array containing dot", () => {
			const params = parseToolParams('{"action":"activate","repos":["."]}');
			assert.deepEqual(params.repos, ["."]);
		});

		it("activate with multiple repos", () => {
			const params = parseToolParams(
				'{"action":"activate","repos":[".","../other-repo"]}',
			);
			assert.deepEqual(params.repos, [".", "../other-repo"]);
		});
	});

	describe("model failures from description quoting", () => {
		it("closing brace instead of bracket — model confuses ] with }", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["."}}',
				"brace-for-bracket",
			);
		});

		it("missing closing bracket — array never terminated", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["."}',
				"missing-bracket",
			);
		});

		it("unescaped quote inside array element — dot with leaked quotes", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["".""]}',
				"leaked-description-quotes",
			);
		});

		it("adjacent strings without comma — two elements with no separator", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["." "./other"]}',
				"missing-comma",
			);
		});

		it("bare dot without quotes — model drops string quoting", () => {
			assertJsonParseError(
				'{"action":"activate","repos":[.]}',
				"bare-dot",
			);
		});

		it("description text leaks into value — model pastes description fragment", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["." for the current repo]}',
				"description-leak",
			);
		});

		it("double-wrapped quotes — model adds extra quote layer", () => {
			assertJsonParseError(
				'{"action":"activate","repos":["\\".\\"]}',
				"double-wrapped",
			);
		});

		it("repos as flat string instead of array — schema violation", () => {
			const params = parseToolParams('{"action":"activate","repos":"."}');
			assert.equal(typeof params.repos, "string");
			assert.equal(Array.isArray(params.repos), false);
		});
	});

	describe("position 33 error reproduction", () => {
		it("reproduces the exact error at position 33, column 34", () => {
			const json = '{"action":"activate","repos":["."}';
			try {
				JSON.parse(json);
				assert.fail("should have thrown");
			} catch (err) {
				const msg = (err as Error).message;
				assert.match(
					msg,
					/position 33|column 34|Unexpected|Expected/i,
					`Error should reference position 33: ${msg}`,
				);
			}
		});
	});
});

// ── NEW SCHEMA: Type.String() ────────────────────────────
// Description: 'Comma-separated repository paths. Use a single dot for the current repo.'
// No embedded quotes, no array nesting → no bracket confusion.

describe("NEW schema: comma-separated string (fix)", () => {
	describe("valid calls all parse cleanly", () => {
		it("activate without repos", () => {
			const params = parseToolParams('{"action":"activate"}');
			assert.equal(params.action, "activate");
			assert.equal(parseRepos(params.repos as string | undefined), undefined);
		});

		it("activate with single dot", () => {
			const params = parseToolParams('{"action":"activate","repos":"."}');
			assert.deepEqual(parseRepos(params.repos as string), ["."]);
		});

		it("activate with multiple repos", () => {
			const params = parseToolParams(
				'{"action":"activate","repos":"., ../other-repo"}',
			);
			assert.deepEqual(parseRepos(params.repos as string), [".", "../other-repo"]);
		});

		it("deactivate", () => {
			const params = parseToolParams('{"action":"deactivate"}');
			assert.equal(params.action, "deactivate");
		});
	});

	describe("old failure modes now impossible", () => {
		it("no brackets to confuse — brace/bracket mismatch cannot happen", () => {
			// Old: {"action":"activate","repos":["."}}  → parse error
			// New: {"action":"activate","repos":"."}     → always valid
			const params = parseToolParams('{"action":"activate","repos":"."}');
			assert.deepEqual(parseRepos(params.repos as string), ["."]);
		});

		it("no array means no missing-comma between elements", () => {
			// Old: {"action":"activate","repos":["." "./other"]}  → parse error
			// New: {"action":"activate","repos":"., ./other"}      → valid string
			const params = parseToolParams(
				'{"action":"activate","repos":"., ./other"}',
			);
			assert.deepEqual(parseRepos(params.repos as string), [".", "./other"]);
		});

		it("no embedded quotes in description — no quote leaking", () => {
			// Old description had "." which leaked into JSON
			// New description says "a single dot" — no quotes to leak
			const params = parseToolParams('{"action":"activate","repos":"."}');
			assert.equal(params.repos, ".");
			assert.deepEqual(parseRepos(params.repos as string), ["."]);
		});

		it("extra spaces in comma-separated list are trimmed", () => {
			const params = parseToolParams(
				'{"action":"activate","repos":" . ,  ../foo , ../bar "}',
			);
			assert.deepEqual(parseRepos(params.repos as string), [
				".",
				"../foo",
				"../bar",
			]);
		});

		it("trailing comma produces no empty entries", () => {
			const params = parseToolParams(
				'{"action":"activate","repos":".,"}',
			);
			assert.deepEqual(parseRepos(params.repos as string), ["."]);
		});
	});
});
