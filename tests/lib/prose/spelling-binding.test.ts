import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPELLING_PAIRS } from "../../../lib/prose/detect.js";

/**
 * Read the "Words the Gate Flags" table from the prose-standard
 * skill. The table is the human-facing source of truth for the
 * Canadian spelling the gate enforces, so the code's
 * SPELLING_PAIRS must match it exactly. If the skill adds, drops
 * or changes a row, this extraction changes and the assertion
 * below fails until the constant is brought back in line (and the
 * other way round).
 */
function skillSpellingPairs(): Array<[string, string]> {
	const path = fileURLToPath(
		new URL("../../../skills/prose-standard/SKILL.md", import.meta.url),
	);
	const lines = readFileSync(path, "utf8").split("\n");
	const pairs: Array<[string, string]> = [];
	let inTable = false;
	for (const line of lines) {
		if (/^### Words the Gate Flags\s*$/.test(line)) {
			inTable = true;
			continue;
		}
		if (!inTable) continue;
		// A table row looks like `| color | colour |`. Stop at the
		// first non-row line once the table has started.
		const cells = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
		if (!cells) {
			if (pairs.length > 0) break;
			continue;
		}
		const from = cells[1];
		const to = cells[2];
		// Skip the header row and its `| --- | --- |` separator.
		if (from === "Not this" || /^-+$/.test(from)) continue;
		pairs.push([from, to]);
	}
	return pairs;
}

describe("Canadian spelling pairs match the prose-standard skill", () => {
	it("SPELLING_PAIRS equals the skill's Words the Gate Flags table", () => {
		const skill = skillSpellingPairs();
		expect(skill.length).toBeGreaterThan(0);
		expect([...SPELLING_PAIRS]).toEqual(skill);
	});
});
