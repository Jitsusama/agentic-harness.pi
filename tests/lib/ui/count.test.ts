import { describe, expect, it } from "vitest";
import { count, noun, verb } from "../../../lib/ui/count.js";

describe("count", () => {
	it("says one thing in the singular, which is the whole point", () => {
		expect(count(1, "tree")).toBe("1 tree");
	});

	it("pluralizes anything else", () => {
		expect(count(3, "tree")).toBe("3 trees");
	});

	it("gives zero the plural, as English does", () => {
		expect(count(0, "tree")).toBe("0 trees");
	});

	it("takes an irregular plural", () => {
		expect(count(2, "entry", "entries")).toBe("2 entries");
		expect(count(1, "entry", "entries")).toBe("1 entry");
	});
});

describe("noun", () => {
	it("gives the word without the number", () => {
		expect(noun(1, "branch", "branches")).toBe("branch");
		expect(noun(4, "branch", "branches")).toBe("branches");
	});
});

describe("verb", () => {
	it("agrees with the count", () => {
		expect(verb(1, "is", "are")).toBe("is");
		expect(verb(0, "is", "are")).toBe("are");
		expect(verb(2, "is", "are")).toBe("are");
	});
});
