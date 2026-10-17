/**
 * A panel's title is the frame's: bold in the strongest text, and no
 * picture before it (`frameTitle` in `lib/ui/frame.ts`).
 *
 * The gates, the confirmations and the boards title themselves that way.
 * The Google and Slack sign-in panels drew plain bold behind a colour
 * emoji, nine of them, one with two spaces to make room for the emoji's
 * width. A mark on a panel comes from the theme's table, one per idea,
 * and a colour picture beside the title is the loudest thing on it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** A title in bold or the frame's, opening on a picture. */
const PICTURE_TITLE =
	/(?:theme\.bold|frameTitle)\(\s*(?:theme,\s*)?["'`]\s*\p{Extended_Pictographic}/u;

function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourcesUnder(path));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(path);
	}
	return found;
}

describe("a panel's title", () => {
	it("opens on its words, with no picture before them", () => {
		const offenders = [
			...sourcesUnder(join(ROOT, "lib")),
			...sourcesUnder(join(ROOT, "extensions")),
		].flatMap((path) =>
			readFileSync(path, "utf8")
				.split("\n")
				.flatMap((line, at) =>
					PICTURE_TITLE.test(line)
						? [`${path.slice(ROOT.length + 1)}:${at + 1}`]
						: [],
				),
		);
		expect(offenders).toEqual([]);
	});
});
