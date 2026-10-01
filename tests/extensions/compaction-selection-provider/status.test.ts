import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { selectionSection } from "../../../extensions/compaction-selection-provider/status.ts";
import { sessionStore } from "../../../extensions/compaction-selection-provider/store.ts";
import { EXCERPTS_HEADING } from "../../../lib/compaction/selection/render.ts";
import { tagged, user } from "../../lib/compaction/selection/fixtures.ts";

function compacted(id: string, summary: string, selection?: unknown) {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-10-01T00:00:00.000Z",
		summary,
		firstKeptEntryId: "x",
		tokensBefore: 240_000,
		details: selection ? { contributions: { selection } } : {},
	} as SessionEntry;
}

describe("the selection's status", () => {
	const store = sessionStore(() => {});

	it("says what will decide the next compaction's excerpts", () => {
		const rule = user("u1", "Always sign every commit you make here.");
		const waiting = user("u2", "Then write the tests for the parser.");
		const section = selectionSection(
			{ classifier: { label: "jev-latest" }, store, budget: 3000, refs: true },
			[rule, tagged(rule, ["rule"]), waiting],
		);

		expect(section.lines).toEqual([
			"classifier: jev-latest",
			"excerpt budget: 3000 tokens",
			"tags kept: on the session",
			"quotes name their paragraph: yes",
			"paragraphs tagged on this branch: 1",
			"messages waiting to be tagged: 1",
			"compactions that quoted excerpts: 0 of 0",
		]);
	});

	it("counts the compactions that quoted, and reads the last one's record", () => {
		const branch = [
			compacted("c1", `summary\n\n${EXCERPTS_HEADING}\n> quoted`),
			compacted("c2", "summary without excerpts", {
				unavailable: "no Jev model has credentials",
				candidates: 4,
				chosen: 0,
				untagged: 12,
			}),
		];
		const section = selectionSection(
			{
				classifier: { unavailable: "no Jev model has credentials" },
				store,
				budget: 0,
				refs: false,
			},
			branch,
		);

		expect(section.lines).toContain(
			"classifier: none: no Jev model has credentials",
		);
		expect(section.lines).toContain("excerpt budget: 0 (excerpts off)");
		expect(section.lines).toContain("compactions that quoted excerpts: 1 of 2");
		expect(section.lines.at(-1)).toBe(
			"last compaction's record: no classifier (no Jev model has credentials); chose 0 of 4 candidates, 12 dropped messages untagged",
		);
	});

	it("says why the last compaction quoted nothing, and how long the classifier took", () => {
		const facts = {
			classifier: { label: "local/tagger" },
			store,
			budget: 3000,
			refs: false,
		} as const;
		const record = {
			label: "local/tagger",
			candidates: 0,
			chosen: 0,
			untagged: 3,
			taggingMs: 12_340,
			judgingMs: 0,
			tokens: 41_000,
			nothingQuoted: "untagged",
		};

		const section = selectionSection(facts, [compacted("c1", "s", record)]);
		expect(section.lines.at(-1)).toBe(
			"last compaction's record: local/tagger; chose 0 of 0 candidates (quoted nothing: untagged), 3 dropped messages untagged; tagging took 12.3s, checking 0.0s of model time, 41000 tokens",
		);

		const off = selectionSection(facts, [
			compacted("c1", "s", { budget: 0, nothingQuoted: "off" }),
		]);
		expect(off.lines.at(-1)).toBe(
			"last compaction's record: quoted nothing, excerpts were off",
		);
	});

	it("says when the last compaction left no record", () => {
		const section = selectionSection(
			{ classifier: { unresolved: true }, store, budget: 3000, refs: false },
			[compacted("c1", "old summary")],
		);

		expect(section.lines.at(-1)).toMatch(/^last compaction's record: none/);
	});
});
