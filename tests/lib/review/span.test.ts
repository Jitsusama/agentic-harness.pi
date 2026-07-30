import { describe, expect, it } from "vitest";
import type { FindingOrigin } from "../../../lib/review/index.js";
import { harvestStackFindings, saidAt } from "../../../lib/review/index.js";

const origin: FindingOrigin = {
	kind: "reviewer",
	runId: "council-20260730-01",
	reviewerId: "wren",
};

/** Roots before children, the order a stack reports its nodes in. */
const stack = [
	"refs/heads/base",
	"refs/heads/middle",
	"refs/heads/tip",
] as const;

const answer = (...findings: unknown[]) => JSON.stringify({ findings });

const one = (over: Record<string, unknown> = {}) => ({
	refs: ["refs/heads/middle"],
	label: "issue",
	subject: "this leaks the handle",
	discussion: "the error path returns before the close",
	location: { kind: "file", file: "lib/a.ts" },
	...over,
});

describe("a finding that belongs to one change", () => {
	it("carries the ref it belongs to", () => {
		const { findings, warnings } = harvestStackFindings(
			answer(one()),
			origin,
			stack,
		);

		expect(warnings).toEqual([]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.span.refs).toEqual(["refs/heads/middle"]);
		expect(findings[0]?.finding.subject).toBe("this leaks the handle");
	});

	it("drops a finding on a ref the stack does not hold", () => {
		// A reviewer inventing a ref is more likely confused than
		// informed, and recording it would put a finding somewhere
		// nobody can read it.
		const { findings, warnings } = harvestStackFindings(
			answer(one({ refs: ["refs/heads/nowhere"] })),
			origin,
			stack,
		);

		expect(findings).toEqual([]);
		expect(warnings[0]).toContain("refs/heads/nowhere");
	});

	it("drops a finding that names no ref at all", () => {
		const { findings, warnings } = harvestStackFindings(
			answer(one({ refs: [] })),
			origin,
			stack,
		);

		expect(findings).toEqual([]);
		expect(warnings[0]).toMatch(/no change|names nothing/i);
	});
});

describe("a finding that spans several changes", () => {
	it("keeps every ref it names", () => {
		const { findings } = harvestStackFindings(
			answer(
				one({ refs: ["refs/heads/tip", "refs/heads/base"], label: "issue" }),
			),
			origin,
			stack,
		);

		expect(findings[0]?.span.refs).toEqual([
			"refs/heads/base",
			"refs/heads/tip",
		]);
	});

	it("orders the refs the way the stack does, not the way they arrived", () => {
		// A reader walking the stack meets these in stack order, so a
		// span reported tip-first would read backwards.
		const { findings } = harvestStackFindings(
			answer(one({ refs: ["refs/heads/tip", "refs/heads/middle"] })),
			origin,
			stack,
		);

		expect(findings[0]?.span.refs).toEqual([
			"refs/heads/middle",
			"refs/heads/tip",
		]);
	});

	it("drops the refs the stack does not hold but keeps the finding", () => {
		const { findings, warnings } = harvestStackFindings(
			answer(one({ refs: ["refs/heads/base", "refs/heads/ghost"] })),
			origin,
			stack,
		);

		expect(findings[0]?.span.refs).toEqual(["refs/heads/base"]);
		expect(warnings[0]).toContain("refs/heads/ghost");
	});

	it("says a span is said at its earliest change", () => {
		// Where the decision was made, and where a reader walking the
		// stack meets it first. Saying it on the tip sends somebody to
		// the consequence rather than the cause.
		expect(
			saidAt({ refs: ["refs/heads/middle", "refs/heads/tip"] }, stack),
		).toBe("refs/heads/middle");
	});

	it("says a single-change finding is said at that change", () => {
		expect(saidAt({ refs: ["refs/heads/tip"] }, stack)).toBe("refs/heads/tip");
	});
});

describe("the witness a location is checked against", () => {
	it("checks a line location against the change it names, not the stack", () => {
		// Each change has its own diff, so a line finding on the tip has
		// to be checked against the tip's diff. Checking against one
		// witness would degrade findings on every other change.
		const witnesses: string[] = [];
		harvestStackFindings(
			answer(
				one({
					refs: ["refs/heads/tip"],
					location: { kind: "line", file: "lib/a.ts", start: 4 },
				}),
			),
			origin,
			stack,
			(ref) => {
				witnesses.push(ref);
				return undefined;
			},
		);

		expect(witnesses).toEqual(["refs/heads/tip"]);
	});

	it("asks for the earliest change's witness when a finding spans several", () => {
		const witnesses: string[] = [];
		harvestStackFindings(
			answer(
				one({
					refs: ["refs/heads/tip", "refs/heads/base"],
					location: { kind: "line", file: "lib/a.ts", start: 4 },
				}),
			),
			origin,
			stack,
			(ref) => {
				witnesses.push(ref);
				return undefined;
			},
		);

		expect(witnesses).toEqual(["refs/heads/base"]);
	});
});

describe("what survives a bad answer", () => {
	it("keeps the good findings when one is malformed", () => {
		const { findings, warnings } = harvestStackFindings(
			answer(one(), one({ label: "vibes" }), one({ refs: ["refs/heads/tip"] })),
			origin,
			stack,
		);

		expect(findings.map((f) => f.span.refs[0])).toEqual([
			"refs/heads/middle",
			"refs/heads/tip",
		]);
		expect(warnings).toHaveLength(1);
	});

	it("warns when nothing parsed", () => {
		const { findings, warnings } = harvestStackFindings(
			"looks fine to me",
			origin,
			stack,
		);

		expect(findings).toEqual([]);
		expect(warnings).toHaveLength(1);
	});
});
