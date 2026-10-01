import { describe, expect, it } from "vitest";
import {
	type Candidate,
	candidatesBefore,
} from "../../../../lib/compaction/selection/candidates.ts";
import {
	holdsFrom,
	holdsRequests,
	readHolds,
} from "../../../../lib/compaction/selection/holds.ts";
import type { SelectionKind } from "../../../../lib/compaction/selection/kinds.ts";
import {
	EXCERPTS_HEADING,
	renderExcerpts,
} from "../../../../lib/compaction/selection/render.ts";
import {
	selectExcerpts,
	whyNothingQuoted,
} from "../../../../lib/compaction/selection/select.ts";
import { readTags } from "../../../../lib/compaction/selection/tags.ts";
import { unitsOfBranch } from "../../../../lib/compaction/selection/units.ts";
import {
	assistant,
	compaction,
	judged,
	passages,
	tagged,
	user,
} from "./fixtures.ts";

function candidate(
	kind: SelectionKind,
	order: number,
	text: string,
): Candidate {
	return {
		kind,
		order,
		unit: {
			entryId: `e${order}`,
			index: 0,
			hash: `h${order}`,
			text,
			speaker: "user",
		},
	};
}

describe("candidatesBefore", () => {
	it("takes tagged paragraphs before the kept entry, under their most durable kind", () => {
		const rule = user("u1", "Always sign commits.\n\nJust chatting here.");
		const finding = assistant("a1", "The cache lives for an hour.");
		const kept = user("u2", "Never force push anything.");
		const branch = [
			rule,
			tagged(rule, ["done", "rule"], []),
			finding,
			tagged(finding, ["finding"]),
			kept,
			tagged(kept, ["rule"]),
		];
		const found = candidatesBefore(branch, readTags(branch), "u2");
		expect(found.map((c) => [c.unit.text, c.kind])).toEqual([
			["Always sign commits.", "rule"],
			["The cache lives for an hour.", "finding"],
		]);
	});

	it("keeps only the latest saying of a repeated paragraph", () => {
		const first = user("u1", "Always sign commits.");
		const again = user("u2", "Always sign commits.");
		const branch = [
			first,
			tagged(first, ["rule"]),
			again,
			tagged(again, ["rule"]),
		];
		const found = candidatesBefore(branch, readTags(branch), undefined);
		expect(found.map((c) => c.unit.entryId)).toEqual(["u2"]);
	});
});

describe("selectExcerpts", () => {
	it("puts rules and corrections first, then lets the other kinds take turns", () => {
		const chosen = selectExcerpts(
			[
				candidate("finding", 1, "finding one"),
				candidate("finding", 2, "finding two"),
				candidate("finding", 3, "finding three"),
				candidate("decision", 4, "decision one"),
				candidate("rule", 5, "rule one"),
			],
			// Room for the rule, the decision and one finding (2, 3 and 4
			// tokens), but not a second finding of 3.
			11,
		);
		expect(chosen.map((c) => c.unit.text)).toEqual([
			"rule one",
			"decision one",
			"finding three",
		]);
	});

	it("leaves out a candidate judged not to hold and quotes one never judged", () => {
		const chosen = selectExcerpts(
			[candidate("rule", 1, "withdrawn"), candidate("rule", 2, "unjudged")],
			100,
			new Map([["h1", 0.1]]),
		);
		expect(chosen.map((c) => c.unit.text)).toEqual(["unjudged"]);
	});

	it("passes over one that does not fit for a smaller one behind it", () => {
		const chosen = selectExcerpts(
			[candidate("rule", 1, "short"), candidate("rule", 2, "x".repeat(400))],
			10,
		);
		expect(chosen.map((c) => c.unit.text)).toEqual(["short"]);
	});
});

describe("whyNothingQuoted", () => {
	const none = {
		candidates: [],
		holds: new Map<string, number>(),
		taggedDropped: 0,
		untaggedDropped: 0,
	};

	it("says nothing was dropped, or that what was dropped was never tagged", () => {
		expect(whyNothingQuoted(none)).toBe("nothing-dropped");
		expect(whyNothingQuoted({ ...none, untaggedDropped: 2 })).toBe("untagged");
	});

	it("says tagged messages held nothing worth quoting, even beside untagged ones", () => {
		expect(
			whyNothingQuoted({ ...none, taggedDropped: 1, untaggedDropped: 2 }),
		).toBe("no-candidates");
	});

	it("tells candidates that no longer hold from ones that did not fit", () => {
		const candidates = [
			candidate("rule", 1, "a"),
			candidate("finding", 2, "b"),
		];
		const withdrawn = new Map([
			["h1", 0.1],
			["h2", 0.2],
		]);
		expect(whyNothingQuoted({ ...none, candidates, holds: withdrawn })).toBe(
			"none-holding",
		);
		expect(
			whyNothingQuoted({
				...none,
				candidates,
				holds: new Map([["h1", 0.1]]),
			}),
		).toBe("over-budget");
	});
});

describe("holds", () => {
	it("asks each candidate in batches, with what the user said later as context", () => {
		const rule = user("u1", "Always sign commits.");
		const later = user("u2", "Forget what I said about signing.");
		const branch = [rule, tagged(rule, ["rule"]), later];
		const candidates = candidatesBefore(branch, readTags(branch), undefined);

		const [request] = holdsRequests(candidates, unitsOfBranch(branch));
		expect(passages(request, "paragraphs")).toEqual(["Always sign commits."]);
		expect(passages(request, "context")).toContain(
			"Forget what I said about signing.",
		);
		const [question] = Object.values(request?.questions ?? {});
		expect(question?.type).toBe("bool");
		expect(question?.instructions).toContain("paragraph u0");
		expect(question?.instructions).toContain("still in force");

		const three = [1, 2, 3].map((n) => candidate("rule", n, `rule ${n}`));
		expect(
			holdsRequests(three, [], 2).map((r) => passages(r, "paragraphs").length),
		).toEqual([2, 1]);
		expect(holdsFrom(three.slice(0, 2), { "u1.holds": 0.2 })).toEqual(
			new Map([["h2", 0.2]]),
		);
	});

	it("reads only the judgements made since the last compaction, latest winning", () => {
		const branch = [
			judged("j1", { stale: 0.9 }),
			compaction("c1"),
			judged("j2", { a: 0.9 }),
			judged("j3", { a: 0.2, b: 0.7 }),
		];
		expect(readHolds(branch)).toEqual(
			new Map([
				["a", 0.2],
				["b", 0.7],
			]),
		);
	});
});

describe("renderExcerpts", () => {
	it("is nothing when nothing was chosen", () => {
		expect(renderExcerpts([])).toBe("");
	});

	it("groups by kind in order said, quoted, and defers to the summary", () => {
		const text = renderExcerpts([
			candidate("finding", 3, "The cache lives\nfor an hour."),
			candidate("rule", 2, "Sign commits."),
			candidate("rule", 1, "Never force push."),
		]);
		expect(text.startsWith(`\n\n${EXCERPTS_HEADING}\n`)).toBe(true);
		expect(text).toContain("the summary is right");
		expect(text.indexOf("### Standing instructions")).toBeLessThan(
			text.indexOf("### Findings"),
		);
		expect(text.indexOf("> Never force push.")).toBeLessThan(
			text.indexOf("> Sign commits."),
		);
		expect(text).toContain("User:\n> The cache lives\n> for an hour.");
	});
});
