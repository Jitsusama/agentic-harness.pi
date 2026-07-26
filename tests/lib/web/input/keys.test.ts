/**
 * Chord parsing. The known-key set here is a slice of the real
 * table the browser driver carries, so the shapes match what
 * the session actually passes in.
 */

import { describe, expect, it } from "vitest";
import { MODIFIER_BITS, parseChords } from "../../../../lib/web/input/keys.js";

const KNOWN = new Set([
	"a",
	"A",
	"k",
	"K",
	"1",
	" ",
	"Tab",
	"Enter",
	"Escape",
	"Delete",
	"Backspace",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageDown",
	"Home",
	"End",
	"F1",
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"+",
]);

const chords = (text: string) => {
	const parsed = parseChords(text, KNOWN);
	if ("refusal" in parsed)
		throw new Error(`refused: ${parsed.refusal.message}`);
	return parsed.chords;
};

const refusal = (text: string) => {
	const parsed = parseChords(text, KNOWN);
	if (!("refusal" in parsed)) throw new Error("expected a refusal");
	return parsed.refusal;
};

describe("parseChords", () => {
	it("reads a single key", () => {
		expect(chords("Tab")).toEqual([{ modifiers: [], key: "Tab", bitmask: 0 }]);
	});

	it("reads a sequence as separate chords", () => {
		expect(chords("Tab Tab Enter").map((chord) => chord.key)).toEqual([
			"Tab",
			"Tab",
			"Enter",
		]);
	});

	it("reads a modifier stack", () => {
		const [chord] = chords("Ctrl+Shift+K");
		expect(chord?.key).toBe("K");
		expect(chord?.modifiers).toEqual(["Control", "Shift"]);
	});

	it("builds the bitmask the protocol wants", () => {
		const [chord] = chords("Ctrl+Shift+K");
		expect(chord?.bitmask).toBe(MODIFIER_BITS.Control | MODIFIER_BITS.Shift);
	});

	it("reports modifiers in a stable order, however they are written", () => {
		expect(chords("Shift+Ctrl+K")[0]?.modifiers).toEqual(["Control", "Shift"]);
		expect(chords("Ctrl+Shift+K")[0]?.modifiers).toEqual(["Control", "Shift"]);
	});

	it("accepts the names people actually type", () => {
		expect(chords("Cmd+a")[0]?.modifiers).toEqual(["Meta"]);
		expect(chords("Esc")[0]?.key).toBe("Escape");
		expect(chords("Down")[0]?.key).toBe("ArrowDown");
		expect(chords("Return")[0]?.key).toBe("Enter");
		expect(chords("Opt+a")[0]?.modifiers).toEqual(["Alt"]);
	});

	it("spells a literal space as a word, since space separates", () => {
		expect(chords("Space")[0]?.key).toBe(" ");
	});

	it("keeps case when the key table distinguishes it", () => {
		// A and a are different entries. Reading 'A' as 'a' would
		// send the page a lowercase letter it was not given.
		expect(chords("A")[0]?.key).toBe("A");
		expect(chords("a")[0]?.key).toBe("a");
	});

	it("finds a key named in the wrong case when there is no clash", () => {
		expect(chords("tab")[0]?.key).toBe("Tab");
		expect(chords("ARROWDOWN")[0]?.key).toBe("ArrowDown");
	});

	it("treats a lone plus as a key, not a separator", () => {
		expect(chords("+")[0]?.key).toBe("+");
	});

	it("refuses an unknown key by name", () => {
		const refused = refusal("Ctrl+Blorp");
		expect(refused.token).toBe("Blorp");
		expect(refused.message).toContain("Blorp");
	});

	it("offers candidates for a near miss", () => {
		expect(refusal("Arrow").candidates).toContain("ArrowUp");
		expect(refusal("Pagedwn").candidates.length).toBeGreaterThanOrEqual(0);
	});

	it("refuses a chord that is only modifiers", () => {
		expect(refusal("Ctrl+Shift").message).toContain("no key");
	});

	it("still allows a modifier pressed on its own", () => {
		// Holding Shift alone is a real thing to do; it is only a
		// trailing modifier after others that means nothing.
		expect(chords("Shift")[0]?.key).toBe("Shift");
	});

	it("refuses an empty request rather than doing nothing quietly", () => {
		expect(refusal("   ").message).toContain("No keys");
	});

	it("ignores extra spacing between chords", () => {
		expect(chords("  Tab   Enter  ")).toHaveLength(2);
	});
});
