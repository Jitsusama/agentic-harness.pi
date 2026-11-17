/** A label a model wrote, made one journal line. */
import { describe, expect, it } from "vitest";
import {
	LABEL_MAX_CHARS,
	LABELS_MOST,
	oneLine,
	oneLineOf,
} from "../../../host/service/one-line.ts";

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

	// A lone half of a pair is written to the journal as a replacement character.
	it("cuts a long label short of a character's two halves", () => {
		const kept = LABEL_MAX_CHARS - "...".length - 1;
		const long = `${"x".repeat(kept)}${"\u{1F600}".repeat(10)}`;
		expect(oneLine(long)).toBe(`${"x".repeat(kept)}...`);
	});

	it("trims what a break leaves at either end", () => {
		expect(oneLine("\n j1 codemode \u0000\r")).toBe("j1 codemode");
	});
});

describe("oneLineOf", () => {
	it("joins labels, each made one line", () => {
		expect(
			oneLineOf(["s1: j1 review\npi-host: forged", "s2: j4 codemode"]),
		).toBe("s1: j1 review pi-host: forged; s2: j4 codemode");
	});

	// Every label is capped, but enough of them joined would still pass
	// journald's LineMax, and a label past the cut would open a new entry.
	it("names only the first labels of a long list, counting the rest", () => {
		const labels = Array.from(
			{ length: LABELS_MOST + 5 },
			(_, at) => `s1: j${at} shell: ${"\u6f22".repeat(LABEL_MAX_CHARS)}`,
		);
		const line = oneLineOf(labels);
		expect(line, "says how many it left out").toMatch(/; and 5 more$/);
		expect(
			Buffer.byteLength(line),
			"well short of journald's 48K LineMax",
		).toBeLessThan(48 * 1024);
	});
});
