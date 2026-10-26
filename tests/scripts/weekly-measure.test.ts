import { describe, expect, it } from "vitest";
import { strayArguments } from "../../scripts/weekly-measure";

describe("the weekly measure's arguments", () => {
	it("takes its two options with their values", () => {
		expect(strayArguments([])).toEqual([]);
		expect(strayArguments(["--out", "/tmp/w.md", "--top", "5"])).toEqual([]);
	});

	it("names what it does not take, so a mistyped run is refused", () => {
		expect(strayArguments(["--help"])).toEqual(["--help"]);
		expect(strayArguments(["--out"])).toEqual(["--out"]);
		expect(strayArguments(["--top", "--out", "x"])).toEqual(["--top"]);
	});
});
