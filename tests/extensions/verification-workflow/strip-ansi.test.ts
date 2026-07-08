import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../extensions/verification-workflow/index.js";

describe("stripAnsi", () => {
	it("removes colour SGR sequences but keeps the text", () => {
		expect(stripAnsi("\u001b[31mRED\u001b[0m done")).toBe("RED done");
	});

	it("removes cursor-control sequences that smear a TUI", () => {
		// Clear-line and cursor-up, as a live test reporter emits.
		expect(stripAnsi("line\u001b[2K\u001b[1Aover")).toBe("lineover");
	});

	it("removes an OSC sequence terminated by BEL", () => {
		expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
	});

	it("removes an OSC sequence terminated by ST (ESC backslash)", () => {
		expect(stripAnsi("\u001b]0;title\u001b\\text")).toBe("text");
	});

	it("removes a CSI sequence with an extended parameter class", () => {
		expect(stripAnsi("a\u001b[38:5:200mb\u001b[0m")).toBe("ab");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("Tests 2220 passed")).toBe("Tests 2220 passed");
	});

	it("strips repeated sequences across the whole string", () => {
		expect(stripAnsi("\u001b[32m✓\u001b[39m a \u001b[32m✓\u001b[39m b")).toBe(
			"✓ a ✓ b",
		);
	});
});
