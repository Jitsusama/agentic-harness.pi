import { describe, expect, it } from "vitest";
import { strayArguments } from "../../scripts/measure";

describe("the measure's arguments", () => {
	it("takes its options, with the values two of them need", () => {
		expect(strayArguments([])).toEqual([]);
		expect(strayArguments(["--out", "/tmp/w.md", "--top", "5"])).toEqual([]);
		expect(strayArguments(["--week", "--top", "5"])).toEqual([]);
	});

	it("names what it does not take, so a mistyped run is refused", () => {
		expect(strayArguments(["--help"])).toEqual(["--help"]);
		expect(strayArguments(["--out"])).toEqual(["--out"]);
		expect(strayArguments(["--top", "--out", "x"])).toEqual(["--top"]);
		expect(strayArguments(["--day"])).toEqual(["--day"]);
	});
});
