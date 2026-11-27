/**
 * The fail-to-pass judgment: which of a change's paths are its tests
 * and which its source, and whether some case passing at the head
 * fails with that source undone.
 */

import { describe, expect, it } from "vitest";
import {
	type CaseOutcome,
	type CaseResults,
	type ChangedPath,
	caseKey,
	exemptionOf,
	judgeFailToPass,
	parseNameStatus,
	parseVitestReport,
	splitChange,
} from "../../../../lib/internal/verification/fail-to-pass.ts";

/** The test file every run below holds. */
const FILE = "tests/lib/sum.test.ts";

/** A run whose cases, by title, ended as given, and whose `unloaded` files never loaded. */
function results(
	cases: Record<string, CaseOutcome>,
	unloaded: string[] = [],
): CaseResults {
	return {
		cases: new Map(
			Object.entries(cases).map(([title, outcome]) => [
				caseKey(FILE, ["sum", title]),
				outcome,
			]),
		),
		unloaded: new Set(unloaded),
	};
}

describe("splitting a change", () => {
	it("sorts the tests from the source and leaves the rest out", () => {
		expect(
			splitChange([
				{ path: "lib/sum.ts", status: "M" },
				{ path: "extensions/a-widget/index.ts", status: "A" },
				{ path: "scripts/run.mjs", status: "D" },
				{ path: "tests/lib/sum.test.ts", status: "M" },
				{ path: "tests/lib/new.test.ts", status: "A" },
				{ path: "tests/support/helper.ts", status: "M" },
				{ path: "docs/testing.md", status: "M" },
				{ path: "lib/README.md", status: "M" },
				{ path: "skills/a-guide/SKILL.md", status: "A" },
			]),
		).toEqual({
			tests: ["tests/lib/sum.test.ts", "tests/lib/new.test.ts"],
			sources: [
				{ path: "lib/sum.ts", status: "M" },
				{ path: "extensions/a-widget/index.ts", status: "A" },
				{ path: "scripts/run.mjs", status: "D" },
			],
		});
	});

	it("leaves out a deleted test, which the head can't run", () => {
		expect(
			splitChange([{ path: "tests/lib/gone.test.ts", status: "D" }]).tests,
		).toEqual([]);
	});

	it("counts a rename out of the source as source, to be taken back", () => {
		const moved: ChangedPath = {
			path: "docs/old.ts",
			status: "R",
			from: "lib/old.ts",
		};
		expect(splitChange([moved]).sources).toEqual([moved]);
	});
});

describe("reading what git and vitest said", () => {
	it("reads git's NUL-ended name-status, renames with both paths", () => {
		expect(
			parseNameStatus(
				"M\0lib/a.ts\0R087\0lib/old.ts\0lib/new.ts\0C100\0lib/a.ts\0lib/b.ts\0D\0lib/c.ts\0",
			),
		).toEqual([
			{ path: "lib/a.ts", status: "M" },
			{ path: "lib/new.ts", status: "R", from: "lib/old.ts" },
			{ path: "lib/b.ts", status: "A" },
			{ path: "lib/c.ts", status: "D" },
		]);
	});

	it("reads vitest's report case by case, and a file with none as unloaded", () => {
		const read = parseVitestReport(
			{
				testResults: [
					{
						name: `/scratch/${FILE}`,
						status: "failed",
						assertionResults: [
							{ ancestorTitles: ["sum"], title: "adds", status: "passed" },
							{ ancestorTitles: ["sum"], title: "subtracts", status: "failed" },
							{ ancestorTitles: ["sum"], title: "later", status: "todo" },
						],
					},
					{
						name: "/scratch/tests/lib/new.test.ts",
						status: "failed",
						message: "Cannot find module '../../lib/new.ts'",
						assertionResults: [],
					},
				],
			},
			(name) => name.replace("/scratch/", ""),
		);
		expect(read).toEqual({
			cases: new Map([
				[caseKey(FILE, ["sum", "adds"]), "passed"],
				[caseKey(FILE, ["sum", "subtracts"]), "failed"],
				[caseKey(FILE, ["sum", "later"]), "skipped"],
			]),
			unloaded: new Set(["tests/lib/new.test.ts"]),
		});
	});

	it("answers nothing for a report not in vitest's shape", () => {
		expect(parseVitestReport({ numTotalTests: 0 }, (name) => name)).toBe(
			undefined,
		);
	});
});

describe("judging the change", () => {
	it("holds on the one case that passes at the head and fails undone", () => {
		expect(
			judgeFailToPass(
				results({ adds: "passed", names: "passed" }),
				results({ adds: "failed", names: "passed" }),
			),
		).toEqual({ held: true, cases: [caseKey(FILE, ["sum", "adds"])] });
	});

	it("refuses when no case fails undone", () => {
		expect(
			judgeFailToPass(
				results({ adds: "passed", later: "skipped" }),
				results({ adds: "passed", later: "skipped" }),
			).held,
		).toBe(false);
	});

	it("refuses when the only case failing undone failed at the head too", () => {
		expect(
			judgeFailToPass(
				results({ adds: "failed", names: "passed" }),
				results({ adds: "failed", names: "passed" }),
			).held,
		).toBe(false);
	});

	it("leaves it unjudged when every test file failed to load undone", () => {
		expect(
			judgeFailToPass(results({ adds: "passed" }), results({}, [FILE])).held,
		).toBe("unjudged");
	});

	it("leaves it unjudged when no changed test ran at the head", () => {
		expect(judgeFailToPass(results({}), results({})).held).toBe("unjudged");
	});
});

describe("a head with nothing to test", () => {
	it("gives the reason a Fail-To-Pass: none trailer names", () => {
		expect(
			exemptionOf("Signed-off-by: A <a@b.c>\nfail-to-pass: None, a rename\n"),
		).toBe("a rename");
	});

	it("gives none for a trailer that isn't none or gives no reason", () => {
		expect(exemptionOf("Fail-To-Pass: tests/lib/sum.test.ts\n")).toBe(
			undefined,
		);
		expect(exemptionOf("Fail-To-Pass: none,\n")).toBe(undefined);
	});
});
