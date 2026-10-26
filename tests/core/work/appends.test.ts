/**
 * The parts of settling additions that need no git: reading a three-way
 * merge, joining two additions, and moving numbers and their citations.
 */

import { describe, expect, it } from "vitest";
import {
	joinAdditions,
	type Move,
	readMerge,
	recite,
	reciteConflicts,
	staleIn,
} from "../../../lib/core/work/appends.ts";

const M = 41;
const lt = `${"<".repeat(M)} ours\n`;
const bar = `${"|".repeat(M)} base\n`;
const eq = `${"=".repeat(M)}\n`;
const gt = `${">".repeat(M)} theirs\n`;

/** A merge output with one conflict of the given sides. */
function merged(before: string, ours: string, base: string, theirs: string) {
	return `${before}${lt}${ours}${bar}${base}${eq}${theirs}${gt}`;
}

function joined(text: string, path = "docs/HISTORY.md") {
	const pieces = readMerge(text);
	if (!pieces) throw new Error("unreadable merge");
	const out = joinAdditions(pieces, path);
	return out && { text: out.lines.join(""), moves: out.moves };
}

describe("reading a three-way merge", () => {
	it("takes git's own seven-character markers in a document as text", () => {
		const text = merged(
			"Example:\n<<<<<<< HEAD\n=======\n>>>>>>> topic\n\n",
			"## A\n",
			"",
			"## B\n",
		);
		expect(joined(text)?.text).toBe(
			"Example:\n<<<<<<< HEAD\n=======\n>>>>>>> topic\n\n## A\n\n## B\n",
		);
	});

	it("refuses markers that do not nest as git writes them", () => {
		expect(readMerge(`${lt}a\n${eq}b\n${gt}`)).toBeUndefined();
		expect(readMerge(`${lt}a\n${bar}${eq}b\n`)).toBeUndefined();
	});
});

describe("joining two additions", () => {
	it("declines a conflict that touches a line the base had", () => {
		expect(joined(merged("", "## A\n", "old\n", "## B\n"))).toBeUndefined();
	});

	it("keeps a blank line between the two blocks, and each side's ending", () => {
		expect(joined(merged("x\r\n\r\n", "## A\r\n", "", "## B\r\n"))?.text).toBe(
			"x\r\n\r\n## A\r\n\r\n## B\r\n",
		);
		expect(joined(merged("", "## A\n\n", "", "## B\n"))?.text).toBe(
			"## A\n\n## B\n",
		);
	});

	it("moves the replayed run up past what landed, keeping its order", () => {
		const out = joined(
			merged(
				"## 1. One\n\n",
				"## 2. Landed\n",
				"",
				"## 2. Mine\n\n## 3. Mine too\n",
			),
		);
		expect(out?.text).toBe(
			"## 1. One\n\n## 2. Landed\n\n## 3. Mine\n\n## 4. Mine too\n",
		);
		expect(out?.moves).toEqual([
			{ path: "docs/HISTORY.md", prefix: "", from: 2, to: 3 },
			{ path: "docs/HISTORY.md", prefix: "", from: 3, to: 4 },
		]);
	});

	it("moves nothing when the numbers claimed do not collide", () => {
		const out = joined(
			merged("## 1. One\n\n", "## 2. Landed\n", "", "## 3. Mine\n"),
		);
		expect(out?.moves).toEqual([]);
	});

	it("leaves a number the base already had, which is cited on purpose", () => {
		const out = joined(
			merged("## 7. Seven\n\n", "## 8. Landed\n", "", "### D7 amendment\n"),
		);
		expect(out?.moves).toEqual([]);
	});
});

describe("rewriting citations", () => {
	const moves: Move[] = [
		{ path: "docs/HISTORY.md", prefix: "", from: 2, to: 3 },
		{ path: "docs/HISTORY.md", prefix: "", from: 3, to: 4 },
		{ path: "AGENTS.md", prefix: "D", from: 12, to: 13 },
	];

	it("moves every citation at once, so moves never chain", () => {
		expect(recite("§2 then §3", moves, "docs/HISTORY.md")).toBe("§3 then §4");
	});

	it("cites a bare number by its file's name outside that file", () => {
		expect(recite("HISTORY §2, but §2 here", moves, "README.md")).toBe(
			"HISTORY §3, but §2 here",
		);
	});

	it("matches whole numbers and whole names only", () => {
		expect(recite("§20 D120 D12x ID12 D12", moves, "docs/HISTORY.md")).toBe(
			"§20 D120 D12x ID12 D13",
		);
	});
});

describe("a conflict the replay's own rewrite made", () => {
	const moves: Move[] = [
		{ path: "docs/HISTORY.md", prefix: "", from: 2, to: 3 },
	];

	function recited(text: string) {
		const pieces = readMerge(text);
		if (!pieces) throw new Error("unreadable merge");
		return reciteConflicts(pieces, moves, "AGENTS.md")?.join("");
	}

	it("takes the replayed side, rewritten the same way", () => {
		expect(
			recited(
				merged(
					"# Agents\n\n",
					"See HISTORY \u00a73.\n",
					"See HISTORY \u00a72.\n",
					"See HISTORY \u00a72.\n\nAlso HISTORY \u00a72.\n",
				),
			),
		).toBe("# Agents\n\nSee HISTORY \u00a73.\n\nAlso HISTORY \u00a73.\n");
	});

	it("declines when the landed side changed anything else", () => {
		expect(
			recited(
				merged(
					"",
					"See HISTORY \u00a73, now.\n",
					"See HISTORY \u00a72.\n",
					"See HISTORY \u00a72.\nMore.\n",
				),
			),
		).toBeUndefined();
	});
});

describe("naming stale citations", () => {
	it("names added lines citing a moved-off number, by new line number", () => {
		const diff = [
			"diff --git a/AGENTS.md b/AGENTS.md",
			"--- a/AGENTS.md",
			"+++ b/AGENTS.md",
			"@@ -4,0 +5,2 @@",
			"+Fine.",
			"+Per HISTORY §2.",
		].join("\n");
		expect(
			staleIn(diff, [{ path: "docs/HISTORY.md", prefix: "", from: 2, to: 3 }]),
		).toEqual([{ path: "AGENTS.md", line: 6, cites: "HISTORY §2" }]);
	});

	it("leaves out a number some other entry moved onto", () => {
		const diff = "+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+HISTORY §3\n";
		expect(
			staleIn(diff, [
				{ path: "docs/HISTORY.md", prefix: "", from: 2, to: 3 },
				{ path: "docs/HISTORY.md", prefix: "", from: 3, to: 4 },
			]),
		).toEqual([]);
	});
});
