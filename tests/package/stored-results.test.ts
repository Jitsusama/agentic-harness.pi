/**
 * A tool that can answer with an unbounded payload must bound it.
 *
 * This is a mechanical rule, so it is checked mechanically. The
 * defect that motivated it was not exotic: a wheel scroll returned
 * two and a half megabytes because one code path rendered a whole
 * accessibility tree into a response, and nothing anywhere said it
 * could not. Every other listing in that family had been budgeted
 * for months.
 *
 * What is checked is that each family known to produce large
 * answers reaches the shared machinery at all. That is a weaker
 * claim than "every answer is bounded", which no static check can
 * make, and a much stronger one than nothing: a new family added
 * without a thought for size shows up here as an absence, and a
 * family that had it and lost it in a refactor shows up as a
 * regression.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Extensions whose tools can answer with a payload larger than a
 * context window, and must therefore store and cite.
 *
 * Each entry is a promise about behaviour, so removing one is a
 * decision to be argued for rather than a way to make this pass.
 */
const MUST_BOUND = [
	"browser-integration",
	"slack-integration",
	"google-workspace-integration",
	"lsp-integration",
	"memory-integration",
	"quest-workflow",
	"pr-workflow",
	"result-store-workflow",
] as const;

/**
 * Families that answer with a pointer to disk instead, which is
 * the same bargain reached by another road.
 *
 * `web-search-integration` writes a bundle and returns a manifest
 * of paths; `subagent-workflow` summarizes a fan-out and names each
 * subagent's result file. Both predate the store and neither needs
 * a handle to be honest about size.
 */
const ANSWER_WITH_PATHS = [
	"web-search-integration",
	"subagent-workflow",
] as const;

/** Every TypeScript source file under a directory. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : sourceFiles(full);
		}
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

/** Whether an extension reaches the shared result machinery. */
function reachesTheStore(extension: string): boolean {
	const dir = join("extensions", extension);
	return sourceFiles(dir).some((file) => {
		const source = readFileSync(file, "utf-8");
		return (
			source.includes("lib/result/") &&
			/\b(citeListing|cite|boundedByDetails|queryStored)\b/.test(source)
		);
	});
}

describe("tools that can answer big must bound their answers", () => {
	for (const extension of MUST_BOUND) {
		it(`${extension} reaches the shared result store`, () => {
			expect(statSync(join("extensions", extension)).isDirectory()).toBe(true);
			expect(reachesTheStore(extension)).toBe(true);
		});
	}

	for (const extension of ANSWER_WITH_PATHS) {
		it(`${extension} still answers with paths on disk`, () => {
			const dir = join("extensions", extension);
			const sources = sourceFiles(dir).map((file) =>
				readFileSync(file, "utf-8"),
			);
			// Either it cites a handle or it names a file. What it must
			// not do is inline an unbounded payload with neither.
			const pointsSomewhere = sources.some(
				(source) =>
					source.includes("lib/result/") ||
					/\b(resultPath|runDir|bundle|manifest)\b/.test(source),
			);
			expect(pointsSomewhere).toBe(true);
		});
	}

	it("names every extension that registers a tool", () => {
		// The point of this one: a new tool-registering extension is
		// either declared as needing to bound its answers, declared as
		// answering with paths, or deliberately listed as small. Adding
		// one without deciding fails here rather than in a bill.
		const small = new Set([
			"advisor",
			"ask-workflow",
			"correction-capture",
			"observability-workflow",
			"mermaid-widget",
			"tdd-workflow",
			"verification-workflow",
			"commit-guardian",
			"pr-guardian",
			"issue-guardian",
			"history-guardian",
			"prompt-coordinator-workflow",
			"pr-workflow-verify",
		]);
		const accounted = new Set<string>([
			...MUST_BOUND,
			...ANSWER_WITH_PATHS,
			...small,
		]);

		const registrars = readdirSync("extensions", { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) =>
				sourceFiles(join("extensions", name)).some((file) =>
					readFileSync(file, "utf-8").includes("registerTool("),
				),
			);

		expect(registrars.filter((name) => !accounted.has(name))).toEqual([]);
	});
});
