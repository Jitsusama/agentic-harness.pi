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
 *
 * That claim turned out to be weaker than it sounded. Reaching the
 * machinery is not using it: the quest verbs called the seam with
 * a details shape it could not read, and a document read cited the
 * one array it could find rather than the body it had just cut.
 * Both were green here, because both were, in the only sense this
 * file could see, wired.
 *
 * So the scan is now half of it. The other half runs the shared
 * seam against the details shapes the families actually produce,
 * which is the half that would have caught them.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundedByDetails } from "../../lib/result/details.js";
import { createResultStore } from "../../lib/result/store.js";

/**
 * Extensions whose tools can answer with a payload larger than a
 * context window, and must therefore store and cite.
 *
 * Each entry is a promise about behaviour, so removing one is a
 * decision to be argued for rather than a way to make this pass.
 *
 * The check is per extension, not per answer: it proves the
 * extension reaches the store, not that every path through it
 * does. A storage read shipped for months previewing a megabyte
 * value with no handle while this passed, because its
 * neighbours in the same extension cited properly. Treat a pass
 * as evidence the machinery is wired, and drive a new answer
 * yourself to find out whether it uses it.
 */
const MUST_BOUND = [
	"browser-integration",
	"slack-integration",
	"google-workspace-integration",
	"lsp-integration",
	"memory-integration",
	"quest-workflow",
	"pr-workflow",
	"review-integration",
	"result-store-workflow",
	"work-integration",
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

	// The shapes the families put in a result's details, taken from
	// the handlers that build them. If one of these drifts, the entry
	// here is wrong and the seam is not; the fix is to follow the
	// handler, not to relax the assertion.
	const REAL_DETAIL_SHAPES: Record<string, unknown> = {
		"slack: a message list": {
			messages: Array.from({ length: 400 }, (_, i) => ({ ts: `${i}` })),
		},
		"quest: a listing under its own key": {
			listing: {
				rows: Array.from({ length: 400 }, (_, i) => ({ id: `Q-${i}` })),
				total: 400,
			},
		},
		"google: a document with comments": {
			file: { name: "Design Notes" },
			content: "the body, which is what the view renders",
			comments: [{ id: "c1" }],
		},
		"google: a document with none": {
			file: { name: "Design Notes" },
			content: "the body, which is what the view renders",
			comments: [],
		},
		"a family that carries nothing structured": undefined,
	};

	for (const [label, details] of Object.entries(REAL_DETAIL_SHAPES)) {
		it(`bounds and cites ${label}`, () => {
			const dir = mkdtempSync(join(tmpdir(), "gate-"));
			try {
				const store = createResultStore({ dir });
				const view = Array.from(
					{ length: 400 },
					(_, i) => `row ${i}: a rendered line with text on it`,
				).join("\n");

				const bounded = boundedByDetails(store, {
					text: view,
					details,
					narrowing: "Ask for fewer.",
				});

				expect(Buffer.byteLength(bounded, "utf-8")).toBeLessThan(
					Buffer.byteLength(view, "utf-8"),
				);
				expect(bounded).toMatch(/handle result-[0-9a-f]{16}/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
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
