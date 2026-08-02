/**
 * A tool row redrawn is the same row, not another one.
 *
 * Pi hands each renderer the component it returned last time and asks
 * for it back, mutated. A renderer that builds a fresh one instead
 * leaves a component nobody updates beside the one that replaced it,
 * and the transcript shows a ghost of the call line above the finished
 * row. It only appears on a row drawn more than once, which in practice
 * means a row on screen while its tool is still running, so the fast
 * tools look fine and the slow and gated ones look cursed.
 *
 * Every renderer in this package had this defect. It went unnoticed for
 * as long as it did because nothing here reads a transcript over time:
 * the renderer tests all pin one call and one string, and by that
 * measure every one of them was correct.
 *
 * So this is checked mechanically, and coarsely. What it asserts is
 * that a file defining render slots mentions the context those slots
 * are handed, once per slot. That is weaker than "no row ghosts",
 * which no static check can make, and much stronger than nothing: a
 * new tool written to the old pattern shows up here as an absence.
 *
 * A slot that genuinely cannot reuse belongs in EXEMPT with its
 * reason, not quietly outside the scan.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSIONS = join(__dirname, "..", "..", "extensions");

/**
 * Render slots that cannot thread a component, with the reason.
 *
 * Empty, and worth keeping that way. The one candidate was a renderer
 * returning a fresh custom widget rather than a Text, which is not
 * exempt so much as a different bug.
 */
const EXEMPT: Record<string, string> = {};

/** Every TypeScript file under the extensions tree. */
function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** How many render slots this source defines. */
function slotsIn(source: string): number {
	return (source.match(/\brender(Call|Result)\s*[(:]/g) ?? []).length;
}

/** How many of them are handed pi's previous component. */
function threadsIn(source: string): number {
	return (source.match(/lastComponent/g) ?? []).length;
}

describe("every tool row pi draws twice", () => {
	const files = sourceFiles(EXTENSIONS).filter((path) =>
		slotsIn(readFileSync(path, "utf8")),
	);

	it("is defined by at least one extension, or this scan proves nothing", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	for (const path of files) {
		const name = path.slice(EXTENSIONS.length + 1);
		const test = EXEMPT[name] ? it.skip : it;

		test(`is reused rather than rebuilt in ${name}`, () => {
			const source = readFileSync(path, "utf8");
			expect(threadsIn(source)).toBeGreaterThanOrEqual(slotsIn(source));
		});
	}
});
