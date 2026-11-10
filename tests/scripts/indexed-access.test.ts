import { describe, expect, it } from "vitest";
import { countErrors, drift, parseList } from "../../scripts/indexed-access.ts";

describe("holding unchecked index reads to the list", () => {
	it("counts each file's errors in tsc's plain output", () => {
		const output = [
			"lib/a.ts(3,7): error TS2532: Object is possibly 'undefined'.",
			"lib/a.ts(9,1): error TS18048: 'x' is possibly 'undefined'.",
			"tests/b.test.ts(1,2): error TS2322: Type 'string | undefined' is not assignable.",
			"  a continuation line that names no file",
		].join("\n");
		expect(Object.fromEntries(countErrors(output))).toEqual({
			"lib/a.ts": 2,
			"tests/b.test.ts": 1,
		});
	});

	it("reads the list's counts, skipping comments and blank lines", () => {
		const text = "# why the list exists\n\nlib/a.ts 2\ntests/b.test.ts 1\n";
		expect(Object.fromEntries(parseList(text))).toEqual({
			"lib/a.ts": 2,
			"tests/b.test.ts": 1,
		});
	});

	it("refuses a file past its count, a new file included", () => {
		const now = new Map([
			["lib/a.ts", 3],
			["lib/new.ts", 1],
		]);
		const { grown } = drift(now, new Map([["lib/a.ts", 2]]));
		expect(grown).toEqual(["lib/a.ts: 3, listed 2", "lib/new.ts: 1, listed 0"]);
	});

	it("asks for a count lowered once a file has fewer, or gone at 0", () => {
		const listed = new Map([
			["lib/a.ts", 2],
			["lib/fixed.ts", 4],
		]);
		const { grown, stale } = drift(new Map([["lib/a.ts", 1]]), listed);
		expect(grown, "fewer reads than listed is never growth").toEqual([]);
		expect(stale).toEqual([
			"lib/a.ts 1 (listed 2)",
			"lib/fixed.ts 0 (listed 4)",
		]);
	});

	it("passes counts that match the list", () => {
		const counts = new Map([["lib/a.ts", 2]]);
		expect(drift(counts, new Map(counts))).toEqual({ grown: [], stale: [] });
	});
});
