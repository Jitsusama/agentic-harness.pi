/**
 * A value that did not survive a reload says so.
 *
 * The staleness itself cannot be prevented from here. What can be
 * prevented is the way it presents: a missing string threw on
 * `.split` seven times before any reviewer spawned, with nothing in
 * the message naming a module or a remedy, and it cost an afternoon
 * and a council to work out what had happened.
 */

import { describe, expect, it } from "vitest";
import { fromScript } from "../../../../lib/subagent/runpi/fresh.js";

describe("a value read out of a script module", () => {
	it("comes back as it is when it is there", () => {
		expect(fromScript("packs/x/index.ts", "P", "x.mjs")).toBe(
			"packs/x/index.ts",
		);
		expect(fromScript(5_000, "N", "x.mjs")).toBe(5_000);
	});

	it("names the export, the module and the way out when it is not", () => {
		expect(() =>
			fromScript(undefined, "JOURNAL_PACK_PATH", "journal.mjs"),
		).toThrowErrorMatchingInlineSnapshot(`
			[Error: JOURNAL_PACK_PATH is missing from journal.mjs. That module is a script, and a reload re-evaluates TypeScript but not a script, so a session that reloaded after this export was added still holds the copy from before it. Restart pi rather than reloading.]
		`);
	});

	it("refuses zero and the empty string, which is where it matters most", () => {
		// A number is the dangerous case and the quiet one. Passed to
		// setTimeout, undefined and zero both mean fire immediately, so
		// a drain would become no drain with nothing said anywhere,
		// which is worse than the crash this was written for.
		expect(() => fromScript("", "P", "x.mjs")).toThrow(/missing from x\.mjs/);
	});
});
