import { describe, expect, it } from "vitest";
import type { FindingOrigin } from "../../../lib/review/index.js";
import { harvestFindings } from "../../../lib/review/index.js";

const origin: FindingOrigin = {
	kind: "reviewer",
	runId: "council-1",
	reviewerId: "hawk",
};

/** The wire shape a reviewer answers in, as one finding. */
function wire(over: Record<string, unknown> = {}) {
	return {
		location: { kind: "file", file: "lib/a.ts" },
		label: "issue",
		subject: "This leaks",
		discussion: "The handle is never closed.",
		...over,
	};
}

const answer = (...findings: unknown[]) => JSON.stringify({ findings });

describe("finding the JSON in what came back", () => {
	it("reads a bare object", () => {
		const { findings, warnings } = harvestFindings(answer(wire()), origin);

		expect(warnings).toEqual([]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.subject).toBe("This leaks");
	});

	it("reads it out of a fenced block", () => {
		// Models wrap JSON in a fence more often than not, and losing a
		// whole council pass to a decoration nobody asked them to omit
		// would be absurd.
		const text = `Here is what I found:\n\n\`\`\`json\n${answer(wire())}\n\`\`\`\n`;

		expect(harvestFindings(text, origin).findings).toHaveLength(1);
	});

	it("reads it with prose either side", () => {
		const text = `I looked at the diff.\n${answer(wire())}\nThat is all.`;

		expect(harvestFindings(text, origin).findings).toHaveLength(1);
	});

	it("prefers the fence when the prose around it also has braces", () => {
		// This is the case the fence scan exists for, and the reason it
		// cannot be replaced by taking the widest brace-delimited span:
		// a model that quotes code while explaining itself puts braces
		// in the prose, and the widest span then swallows the prose and
		// parses as nothing. Discovered by a surviving mutant: deleting
		// the fence scan passed every other test in this file.
		const text = [
			"I noticed `const held = { open: true }` near the top,",
			"and `if (x) { close() }` below it. My answer:",
			"```json",
			answer(wire({ subject: "from the fence" })),
			"```",
			"Happy to expand on any of { these }.",
		].join("\n");

		const { findings } = harvestFindings(text, origin);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.subject).toBe("from the fence");
	});

	it("takes an empty findings list as a clean review", () => {
		// Nothing to say is a legitimate answer and must not read as a
		// failure to parse.
		const { findings, warnings } = harvestFindings(answer(), origin);

		expect(findings).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("warns when there is no JSON at all", () => {
		const { findings, warnings } = harvestFindings(
			"I could not read it.",
			origin,
		);

		expect(findings).toEqual([]);
		expect(warnings.join(" ")).toMatch(/json|findings/i);
	});

	it("warns when the JSON has no findings key", () => {
		const { warnings } = harvestFindings(JSON.stringify({ notes: [] }), origin);

		expect(warnings.join(" ")).toMatch(/findings/);
	});
});

describe("one finding at a time", () => {
	it("keeps the good ones when one is malformed", () => {
		// The whole point. One bad entry among ten must cost one
		// finding, not the pass, because re-running a council is
		// expensive and the nine were fine.
		const { findings, warnings } = harvestFindings(
			answer(
				wire({ subject: "first" }),
				{ label: "issue" },
				wire({ subject: "third" }),
			),
			origin,
		);

		expect(findings.map((f) => f.subject)).toEqual(["first", "third"]);
		expect(warnings).toHaveLength(1);
	});

	it("names which entry it dropped", () => {
		const { warnings } = harvestFindings(
			answer(wire(), { label: "issue" }),
			origin,
		);

		expect(warnings[0]).toMatch(/\b1\b/);
	});

	it("drops one with no subject", () => {
		expect(
			harvestFindings(answer(wire({ subject: "  " })), origin).findings,
		).toEqual([]);
	});

	it("keeps one with an unknown label, calling it a note", () => {
		// Measured, not supposed. The journal's first real council
		// recorded 86 findings across seven reviewers; one of them
		// labelled its entries defect, testing and design, and lost all
		// eleven. It answered anyway, so nothing was lost that time,
		// which is the whole problem: had it been stopped, its journal
		// would have rescued nothing in the one case the journal exists
		// for.
		const { findings, warnings } = harvestFindings(
			answer(wire({ label: "grumble", subject: "the lock is held too long" })),
			origin,
		);

		expect(findings.map((f) => f.subject)).toEqual([
			"the lock is held too long",
		]);
		// The most neutral label there is, so the finding asserts no
		// more than the reviewer did.
		expect(findings[0]?.label).toBe("note");
		// Their own word survives, so nobody has to guess what they
		// meant by it.
		expect(warnings[0]).toContain("grumble");
	});

	it("reads a capitalized label as the label it plainly is", () => {
		const { findings, warnings } = harvestFindings(
			answer(wire({ label: "Issue" })),
			origin,
		);

		expect(findings[0]?.label).toBe("issue");
		expect(warnings).toEqual([]);
	});

	it("stamps every finding with the origin it was told", () => {
		const { findings } = harvestFindings(answer(wire()), origin);

		expect(findings[0]?.origin).toEqual(origin);
	});
});

describe("where a finding points", () => {
	it("anchors a line finding to its line and side", () => {
		const { findings } = harvestFindings(
			answer(
				wire({
					location: {
						kind: "line",
						file: "lib/a.ts",
						start: 12,
						end: 14,
						side: "new",
					},
				}),
			),
			origin,
		);

		expect(findings[0]?.anchor).toEqual({
			subject: "line",
			path: "lib/a.ts",
			blob: "new",
			line: 14,
			startLine: 12,
		});
	});

	it("treats a single line as a line rather than a range of one", () => {
		const { findings } = harvestFindings(
			answer(
				wire({
					location: {
						kind: "line",
						file: "lib/a.ts",
						start: 12,
						end: 12,
						side: "new",
					},
				}),
			),
			origin,
		);

		expect(findings[0]?.anchor).toEqual({
			subject: "line",
			path: "lib/a.ts",
			blob: "new",
			line: 12,
		});
	});

	it("defaults a line finding to the new side", () => {
		// The side a reviewer means is almost always the one they read,
		// and the new side is what a diff shows by default.
		const { findings } = harvestFindings(
			answer(
				wire({
					location: { kind: "line", file: "lib/a.ts", start: 3, end: 3 },
				}),
			),
			origin,
		);

		expect(findings[0]?.anchor).toMatchObject({ blob: "new" });
	});

	it("anchors a file finding to the file", () => {
		const { findings } = harvestFindings(answer(wire()), origin);

		expect(findings[0]?.anchor).toEqual({ subject: "file", path: "lib/a.ts" });
	});

	it("anchors a global finding to the change", () => {
		const { findings } = harvestFindings(
			answer(wire({ location: { kind: "global" } })),
			origin,
		);

		expect(findings[0]?.anchor).toEqual({ subject: "change" });
	});

	it("records the witness on every anchor when it is given one", () => {
		// Without the witness an anchor cannot say whether a force-push
		// stranded it or the backend kept it reachable.
		const { findings } = harvestFindings(answer(wire()), origin, "abc123");

		expect(findings[0]?.anchor).toMatchObject({ witness: "abc123" });
	});

	it("keeps a line finding with no file against the change", () => {
		const { findings, warnings } = harvestFindings(
			answer(wire({ location: { kind: "line", start: 1, end: 1 } })),
			origin,
		);

		expect(findings[0]?.anchor.subject).toBe("change");
		expect(warnings[0]).toMatch(/file/i);
	});

	it("anchors a line named as a line rather than a start", () => {
		// Measured on a real journal: nine of eleven recorded findings
		// named the line as `line`, which is what the anchor they
		// produce calls it. Reading only `start` cost every one of them
		// its line number.
		const { findings, warnings } = harvestFindings(
			answer(wire({ location: { kind: "line", file: "lib/a.ts", line: 42 } })),
			origin,
		);

		expect(findings[0]?.anchor).toMatchObject({
			subject: "line",
			path: "lib/a.ts",
			line: 42,
		});
		expect(warnings).toEqual([]);
	});

	it("keeps a line finding with no line against the file", () => {
		// The commonest way a reviewer gets a location wrong, and the
		// one that costs least to forgive: it named the file, so the
		// remark still lands somewhere a reader can act on.
		const { findings } = harvestFindings(
			answer(wire({ location: { kind: "line", file: "lib/a.ts" } })),
			origin,
		);

		expect(findings[0]?.anchor).toMatchObject({
			subject: "file",
			path: "lib/a.ts",
		});
	});

	it("keeps one whose location kind is unknown against what it named", () => {
		const { findings } = harvestFindings(
			answer(wire({ location: { kind: "vibes", file: "lib/a.ts" } })),
			origin,
		);

		expect(findings[0]?.anchor).toMatchObject({
			subject: "file",
			path: "lib/a.ts",
		});
	});

	it("keeps one that names no location at all against the change", () => {
		const { findings } = harvestFindings(
			answer(wire({ location: undefined })),
			origin,
		);

		expect(findings[0]?.anchor.subject).toBe("change");
	});

	it("still drops an entry that says nothing at all", () => {
		// The line the leniency stops at. A finding is forgiven for how
		// it is decorated and for where it points, never for having no
		// observation in it, because there is nothing left to keep.
		const { findings } = harvestFindings(
			answer(wire({ subject: "  " }), "not an object at all"),
			origin,
		);

		expect(findings).toEqual([]);
	});
});

describe("the optional parts", () => {
	it("keeps a canonical severity", () => {
		const { findings } = harvestFindings(
			answer(wire({ severity: "critical" })),
			origin,
		);

		expect(findings[0]?.severity).toBe("critical");
	});

	it("maps the aliases models actually use", () => {
		// Nobody reads the contract that carefully, and mapping a
		// synonym costs nothing next to dropping the severity.
		const cases: [string, string][] = [
			["blocking", "critical"],
			["required", "critical"],
			["high", "critical"],
			["low", "minor"],
			["nice-to-have", "minor"],
			["info", "minor"],
		];
		for (const [given, want] of cases) {
			const { findings } = harvestFindings(
				answer(wire({ severity: given })),
				origin,
			);
			expect(findings[0]?.severity, given).toBe(want);
		}
	});

	it("drops an unknown severity but keeps the finding", () => {
		// The severity is a decoration; the observation is the value.
		const { findings, warnings } = harvestFindings(
			answer(wire({ severity: "spicy" })),
			origin,
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBeUndefined();
		expect(warnings[0]).toContain("spicy");
	});

	it("keeps a confidence inside the range", () => {
		expect(
			harvestFindings(answer(wire({ confidence: 0.8 })), origin).findings[0]
				?.confidence,
		).toBe(0.8);
	});

	it("drops a confidence outside it, keeping the finding", () => {
		const { findings, warnings } = harvestFindings(
			answer(wire({ confidence: 12 })),
			origin,
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.confidence).toBeUndefined();
		expect(warnings).toHaveLength(1);
	});
});
