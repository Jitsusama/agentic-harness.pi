/**
 * Reading an answer that was cut off mid-sentence.
 *
 * A reviewer stopped at its budget stops wherever it happened to be,
 * which for a long answer is usually partway through the findings
 * array. The whole answer will not parse, and the round used to drop
 * every finding in it, including the dozens that arrived intact.
 */

import { describe, expect, it } from "vitest";
import { harvestAudits } from "../../../lib/review/ask/audit.js";
import { harvestCritiques } from "../../../lib/review/ask/critique.js";
import { harvestStackFindings } from "../../../lib/review/ask/span.js";
import { findJson, salvageJson } from "../../../lib/review/ask/wire.js";
import type { FindingOrigin } from "../../../lib/review/index.js";
import { harvestFindings } from "../../../lib/review/index.js";

/** An answer that got as far as `count` findings and then stopped. */
function cutOffAfter(count: number, trailing: string): string {
	const done = Array.from(
		{ length: count },
		(_, index) =>
			`{"title": "finding ${index}", "severity": "minor", "body": "a body"}`,
	).join(", ");
	return `\`\`\`json\n{"findings": [${done}${trailing}`;
}

/** The titles of whatever was recovered, in order. */
function titles(salvaged: Record<string, unknown> | undefined): string[] {
	const held = salvaged?.findings;
	if (!Array.isArray(held)) return [];
	return held.map((entry) =>
		typeof entry === "object" && entry !== null && "title" in entry
			? String((entry as { title: unknown }).title)
			: "",
	);
}

describe("salvaging a truncated answer", () => {
	it("keeps the findings that arrived whole", () => {
		const salvaged = salvageJson(
			cutOffAfter(3, ', {"title": "finding 3", "sev'),
		);

		expect(titles(salvaged)).toEqual(["finding 0", "finding 1", "finding 2"]);
	});

	it("drops only the entry that was interrupted", () => {
		// The half-written one cannot be recovered and must not be
		// guessed at: a finding invented from a fragment is worse than
		// a finding lost, because it reads exactly like a real one.
		const salvaged = salvageJson(cutOffAfter(2, ', {"title": "finding 2"'));

		expect(salvaged?.findings).toHaveLength(2);
	});

	it("survives a cut inside a string, brace and all", () => {
		// A body holding a brace is ordinary in code review, and a cut
		// inside one leaves an unbalanced brace that a naive scan
		// would count as structure.
		const salvaged = salvageJson(
			'{"findings": [{"title": "a", "severity": "minor", "body": "use if (x) { y }"}, {"title": "b", "body": "an unclosed { and then',
		);

		expect(salvaged?.findings).toHaveLength(1);
	});

	it("keeps an escaped quote from ending the string early", () => {
		const salvaged = salvageJson(
			'{"findings": [{"title": "the \\" quote", "severity": "minor"}, {"title": "cut',
		);

		expect(titles(salvaged)).toEqual(['the " quote']);
	});

	it("recovers nothing when not one entry finished", () => {
		// Better to say nothing was readable than to hand back an empty
		// findings array, which reads as a reviewer that found nothing.
		expect(salvageJson('{"findings": [{"title": "only a fragm')).toBe(
			undefined,
		);
	});

	it("leaves an answer that parses to the strict reader", () => {
		// Salvage is the fallback, so it never sees a whole answer. It
		// still must not claim one is broken.
		const whole = '{"findings": [{"title": "a", "severity": "minor"}]}';

		expect(findJson(whole)).toBeDefined();
		expect(titles(salvageJson(whole))).toEqual(["a"]);
	});

	it("says nothing about text holding no JSON at all", () => {
		expect(salvageJson("I could not review this, sorry.")).toBe(undefined);
	});
});

const origin: FindingOrigin = {
	kind: "reviewer",
	runId: "council-1",
	reviewerId: "hawk",
};

/** A reviewer's answer that stopped partway through finding `count`. */
function interrupted(count: number): string {
	const done = Array.from({ length: count }, (_, index) =>
		JSON.stringify({
			location: { kind: "file", file: `lib/a${index}.ts` },
			label: "issue",
			subject: `This leaks (${index})`,
			discussion: "The handle is never closed.",
		}),
	).join(", ");
	return `Here is what I found.\n\n\`\`\`json\n{"findings": [${done}, {"location": {"kind": "fil`;
}

describe("harvesting an answer that was cut off", () => {
	it("keeps the findings the reviewer managed to send", () => {
		// The round this is drawn from paid for seven reviewers and
		// took nothing from any of them, because one unfinished entry
		// condemned every finished one in the same answer.
		const harvest = harvestFindings(interrupted(12), origin);

		expect(harvest.findings).toHaveLength(12);
		expect(harvest.findings[0]?.subject).toBe("This leaks (0)");
	});

	it("says the answer was cut off rather than unreadable", () => {
		const harvest = harvestFindings(interrupted(3), origin);

		expect(harvest.warnings.join(" ")).toMatch(/cut off|truncat|stopped/i);
		// The old wording blamed the answer's shape, which sent whoever
		// read it looking for a contract the reviewer had followed.
		expect(harvest.warnings.join(" ")).not.toMatch(/Nothing in this answer/);
	});

	it("still reports an answer holding no JSON at all as unreadable", () => {
		const harvest = harvestFindings("I could not review this, sorry.", origin);

		expect(harvest.findings).toEqual([]);
		expect(harvest.warnings.join(" ")).toMatch(/Nothing in this answer/);
	});
});

/** An answer under `key` that stopped partway through entry `count`. */
function cutShort(key: string, entries: unknown[]): string {
	const done = entries.map((entry) => JSON.stringify(entry)).join(", ");
	return `\`\`\`json\n{"${key}": [${done}, {"rationale": "and this one was inte`;
}

describe("the other rounds, cut off the same way", () => {
	// Each of these reads its answer through the same door, and each
	// could be interrupted in the same place. The stack round matters
	// most: it is the one asked to hold every change at once, so it
	// writes the longest answers and is the likeliest to be stopped.
	it("keeps the spans a stack reviewer finished", () => {
		const harvest = harvestStackFindings(
			cutShort("findings", [
				{
					refs: ["refs/heads/tip"],
					location: { kind: "file", file: "lib/a.ts" },
					label: "issue",
					subject: "This leaks",
					discussion: "The handle is never closed.",
				},
			]),
			origin,
			["refs/heads/tip"],
		);

		expect(harvest.findings).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});

	it("keeps the positions a critic finished", () => {
		const harvest = harvestCritiques(
			cutShort("critiques", [
				{ findingId: 1, position: "agree", rationale: "it really is open" },
			]),
			"hawk",
			[1],
		);

		expect(harvest.critiques).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});

	it("keeps the standings an auditor finished", () => {
		const harvest = harvestAudits(
			cutShort("audits", [
				{ threadIndex: 1, standing: "addressed", rationale: "closed now" },
			]),
			"wren",
			[1],
		);

		expect(harvest.audits).toHaveLength(1);
		expect(harvest.warnings.join(" ")).toMatch(/cut off/i);
	});
});
