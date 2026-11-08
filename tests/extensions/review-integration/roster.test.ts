import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_ONLY } from "../../../extensions/review-integration/roster.ts";

/**
 * The names of pi's built-in tools, as its own source lists them. pi
 * exports no list, so it is read from the file that declares them.
 */
function pisToolNames(): string[] {
	// The package exports no file of its own by path, so it is read from
	// where the repository installs it.
	const file = fileURLToPath(
		new URL(
			"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js",
			import.meta.url,
		),
	);
	const source = readFileSync(file, "utf8");
	const listed = /allToolNames = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
	if (listed === undefined) throw new Error("pi's tool names weren't found");
	return [...listed.matchAll(/"([\w-]+)"/g)].map((m) => m[1] ?? "");
}

describe("what a reviewer reads with", () => {
	it("is tools pi has, by pi's own names", () => {
		// A `glob` pi has none of left every reviewer without a file finder
		// until 8 November (ISXEG8).
		const known = pisToolNames();
		expect(known).toContain("find");
		for (const tool of READ_ONLY) expect(known).toContain(tool);
	});

	it("can change nothing", () => {
		expect(READ_ONLY).not.toContain("bash");
		expect(READ_ONLY).not.toContain("edit");
		expect(READ_ONLY).not.toContain("write");
	});
});
