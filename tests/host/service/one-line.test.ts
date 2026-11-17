/** A label a model wrote, made one journal line. */
import { describe, expect, it } from "vitest";
import { LABEL_MAX_CHARS, oneLine } from "../../../host/service/one-line.ts";

describe("oneLine", () => {
	it("leaves a plain label as it is", () => {
		expect(oneLine("j1 subagent: review")).toBe("j1 subagent: review");
	});

	it.each([
		["a line feed", "\n"],
		["a carriage return", "\r"],
		["a NUL, which journald also ends a line at", "\u0000"],
		["an escape, which a terminal reading the journal obeys", "\u001b"],
		["a line separator", "\u2028"],
		["a next line", "\u0085"],
		[
			"a right-to-left override, which reorders what a terminal shows",
			"\u202e",
		],
		["a directional isolate", "\u2066"],
		["a zero-width space, which hides where a label ends", "\u200b"],
	])("collapses %s into one space", (_, breaking) => {
		expect(oneLine(`j1 shell: nix build${breaking}pi-host: forged`)).toBe(
			"j1 shell: nix build pi-host: forged",
		);
	});

	// They join an emoji or spell a Persian or Indic word, and reorder nothing.
	it("keeps the zero-width joiner and non-joiner", () => {
		expect(
			oneLine("j1 shell: \u{1F469}\u200d\u{1F467} \u0645\u06cc\u200c\u062e"),
		).toBe("j1 shell: \u{1F469}\u200d\u{1F467} \u0645\u06cc\u200c\u062e");
	});

	// journald cuts a line past its LineMax into a new entry, which the
	// label's tail would then open as if the host had said it.
	it("cuts a long label short, saying so", () => {
		const long = `j1 review: ${"x".repeat(5000)}pi-host: forged`;
		const line = oneLine(long);
		expect(line.length, "well short of journald's cut").toBeLessThanOrEqual(
			LABEL_MAX_CHARS,
		);
		expect(line, "says it was cut").toMatch(/\.\.\.$/);
		expect(line, "the forged tail is gone").not.toContain("forged");
	});

	it("trims what a break leaves at either end", () => {
		expect(oneLine("\n j1 codemode \u0000\r")).toBe("j1 codemode");
	});
});
