/**
 * A diff in its colours: what was added and taken out in theirs, the
 * rest quiet.
 *
 * A hunk's header is structure, as the file's header is, so it is dim.
 * It was in the accent, which is where the keys go, and a diff of five
 * hunks drew five places to look that no key reaches.
 */

import { describe, expect, it } from "vitest";
import { renderDiff } from "../../../lib/ui/content-renderer.ts";
import { fakeTheme } from "./fake-theme.ts";

const DIFF = [
	"diff --git a/x.ts b/x.ts",
	"--- a/x.ts",
	"+++ b/x.ts",
	"@@ -1,2 +1,2 @@",
	" kept",
	"-gone",
	"+come",
].join("\n");

describe("a diff", () => {
	const lines = renderDiff(DIFF, fakeTheme(), 400);

	it("draws a hunk's header dim, as structure", () => {
		expect(lines[3]).toBe("<dim> @@ -1,2 +1,2 @@</dim>");
	});

	it("draws what changed in the diff's own colours", () => {
		expect(lines.slice(4)).toEqual([
			"<toolDiffContext>  kept</toolDiffContext>",
			"<toolDiffRemoved> -gone</toolDiffRemoved>",
			"<toolDiffAdded> +come</toolDiffAdded>",
		]);
	});

	it("keeps the accent out of it", () => {
		expect(lines.join("\n")).not.toContain("<accent>");
	});
});
