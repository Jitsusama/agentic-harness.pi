import { describe, expect, it } from "vitest";
import { parseTarget } from "../../../../lib/web/target/index.js";

describe("parseTarget", () => {
	it("reads a role and a name", () => {
		expect(parseTarget("navigation Main")).toEqual({
			role: "navigation",
			name: "Main",
		});
	});

	it("keeps a name that runs to several words", () => {
		expect(parseTarget("button Add to cart")).toEqual({
			role: "button",
			name: "Add to cart",
		});
	});

	it("reads a bare role as the unnamed element of that role", () => {
		// The outline prints an unnamed landmark as main "", so a
		// caller writing 'main' means exactly that.
		expect(parseTarget("main")).toEqual({ role: "main", name: "" });
	});

	it("strips quotes a caller copied from the outline", () => {
		expect(parseTarget('link "Home"')).toEqual({ role: "link", name: "Home" });
		expect(parseTarget("link 'Home'")).toEqual({ role: "link", name: "Home" });
	});

	it("treats explicit empty quotes as the unnamed element", () => {
		expect(parseTarget('form ""')).toEqual({ role: "form", name: "" });
	});

	it("ignores the whitespace around what it was given", () => {
		expect(parseTarget("  button   Save  ")).toEqual({
			role: "button",
			name: "Save",
		});
	});

	it("reports nothing for a spec with no role in it", () => {
		expect(parseTarget("")).toBeUndefined();
		expect(parseTarget("   ")).toBeUndefined();
	});
});
