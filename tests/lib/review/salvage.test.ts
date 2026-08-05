/**
 * Reading an answer that was cut off mid-sentence.
 *
 * A reviewer stopped at its budget stops wherever it happened to be,
 * which for a long answer is partway through the findings array. The
 * whole answer will not parse, and the round used to drop every finding
 * in it, including the dozens that arrived intact.
 *
 * The fixtures here nest, on purpose. An earlier version of this file
 * used flat entries throughout and passed against an implementation
 * that admitted half-written findings, because every real finding
 * carries a nested location and no fixture did. A council caught it,
 * four reviewers independently. Keep the nesting.
 */

import { describe, expect, it } from "vitest";
import { harvestAudits } from "../../../lib/review/ask/audit.js";
import { harvestCritiques } from "../../../lib/review/ask/critique.js";
import { harvestStackFindings } from "../../../lib/review/ask/span.js";
import { readAnswer } from "../../../lib/review/ask/wire.js";
import type { FindingOrigin } from "../../../lib/review/index.js";
import { harvestFindings } from "../../../lib/review/index.js";

/** A finding shaped the way the output contract asks for one. */
function finding(subject: string) {
	return {
		location: { kind: "file", file: "lib/a.ts" },
		label: "issue",
		subject,
		discussion: "The handle is never closed.",
	};
}

/** An answer holding `count` whole findings and then `tail`, unfinished. */
function cutOff(count: number, tail: string): string {
	const done = Array.from({ length: count }, (_, index) =>
		JSON.stringify(finding(`finding ${index}`)),
	).join(", ");
	return `\`\`\`json\n{"findings": [${done}${tail}`;
}

/** The subjects salvage recovered, in order. */
function subjects(text: string): string[] {
	const held = readAnswer(text, "findings").parsed?.findings;
	if (!Array.isArray(held)) return [];
	return held.map((entry) =>
		typeof entry === "object" && entry !== null && "subject" in entry
			? String((entry as { subject: unknown }).subject)
			: "?",
	);
}

describe("salvaging a truncated answer", () => {
	it("keeps the findings that arrived whole", () => {
		expect(subjects(cutOff(3, ', {"location": {"kind": "fil'))).toEqual([
			"finding 0",
			"finding 1",
			"finding 2",
		]);
	});

	it("drops an entry cut off after a nested value closed", () => {
		// The bug this file exists to prevent. The interrupted entry has
		// a complete location, so a reader looking for a point where
		// everything open could be closed finds one inside the entry,
		// and hands on a finding whose argument was never written. It
		// reads exactly like a finding the reviewer made.
		const half =
			', {"location": {"kind": "file", "file": "lib/b.ts"}, "label": "issue", "subject": "half", "discussion": "the argument is nev';

		expect(subjects(cutOff(2, half))).toEqual(["finding 0", "finding 1"]);
	});

	it("drops an entry cut off inside a nested value", () => {
		expect(
			subjects(cutOff(1, ', {"location": {"kind": "file", "file": "lib/b')),
		).toEqual(["finding 0"]);
	});

	it("is not defeated by a brace in the reviewer's prose", () => {
		// findJson tries a fenced block before the widest brace span for
		// exactly this reason, and its docstring says so. Salvage used
		// to start at the first brace in the whole answer and so lost
		// everything to a preamble like this one.
		const answer = `I looked at the if (x) { y } branch first.\n\n${cutOff(
			2,
			', {"location": {"kind": "fil',
		)}`;

		expect(subjects(answer)).toEqual(["finding 0", "finding 1"]);
	});

	it("survives a brace and a quote inside a discussion", () => {
		const answer =
			'{"findings": [{"location": {"kind": "file", "file": "a.ts"}, "label": "issue", "subject": "braces", "discussion": "use if (x) { y } and a \\" quote"}, {"location": {"kind": "fil';

		expect(subjects(answer)).toEqual(["braces"]);
	});

	it("recovers nothing when not one entry finished", () => {
		expect(subjects('{"findings": [{"location": {"kind": "fi')).toEqual([]);
		expect(
			readAnswer('{"findings": [{"location": {"kind": "fi', "findings").parsed,
		).toBe(undefined);
	});

	it("says nothing about text holding no JSON at all", () => {
		expect(
			readAnswer("I could not review this, sorry.", "findings").parsed,
		).toBe(undefined);
	});

	it("leaves a whole answer to the strict reader", () => {
		const whole = `{"findings": [${JSON.stringify(finding("a"))}]}`;
		const read = readAnswer(whole, "findings");

		expect(read.truncated).toBe(false);
		expect(subjects(whole)).toEqual(["a"]);
	});

	it("takes the anchor that recovered the most, not the first", () => {
		// A reviewer that shows its working writes a smaller array
		// earlier in the prose, the same trap findJson's widest-span
		// rule exists for.
		const answer = `First sketch: {"findings": []}\n\nAnd now properly:\n${cutOff(
			3,
			', {"location": {"kind": "fil',
		)}`;

		expect(subjects(answer)).toHaveLength(3);
	});
});

const origin: FindingOrigin = {
	kind: "reviewer",
	runId: "council-1",
	reviewerId: "hawk",
};

describe("harvesting an answer that was cut off", () => {
	it("keeps the findings the reviewer managed to send", () => {
		const harvest = harvestFindings(
			cutOff(12, ', {"location": {"kind'),
			origin,
		);

		expect(harvest.findings).toHaveLength(12);
		expect(harvest.findings[0]?.subject).toBe("finding 0");
	});

	it("says the answer was cut off rather than unreadable", () => {
		const harvest = harvestFindings(cutOff(3, ', {"location": {"kind'), origin);

		expect(harvest.truncated).toBe(true);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
		expect(harvest.warnings.join(" ")).not.toMatch(/Nothing in this answer/);
	});

	it("still reports an answer holding no JSON at all as unreadable", () => {
		const harvest = harvestFindings("I could not review this, sorry.", origin);

		expect(harvest.findings).toEqual([]);
		expect(harvest.truncated).toBe(false);
		expect(harvest.warnings.join(" ")).toMatch(/Nothing in this answer/);
	});
});

describe("the other rounds, cut off the same way", () => {
	it("keeps the spans a stack reviewer finished", () => {
		const harvest = harvestStackFindings(
			`{"findings": [${JSON.stringify({
				...finding("a stack thing"),
				refs: ["refs/heads/tip"],
			})}, {"refs": ["refs/heads/ti`,
			origin,
			["refs/heads/tip"],
		);

		expect(harvest.findings).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});

	it("keeps the positions a critic finished", () => {
		const harvest = harvestCritiques(
			'{"critiques": [{"findingId": 1, "position": "agree", "rationale": "it is open"}, {"findingId": 2, "posi',
			"hawk",
			[1, 2],
		);

		expect(harvest.critiques).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});

	it("keeps the standings an auditor finished", () => {
		const harvest = harvestAudits(
			'{"audits": [{"threadIndex": 1, "standing": "addressed", "rationale": "closed"}, {"threadIndex": 2, "stan',
			"wren",
			[1, 2],
		);

		expect(harvest.audits).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});
});
