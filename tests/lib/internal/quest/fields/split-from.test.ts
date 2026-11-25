/**
 * The cell a quest's work split from, read as mycelium's node reads a
 * cell's `lineage.split_from`: what forage::is_address would pass over
 * is passed over here, so a split is never written that no map draws.
 */
import { describe, expect, it } from "vitest";
import {
	isCellAddress,
	splitFromOf,
} from "../../../../../lib/internal/quest/fields/split-from.ts";

describe("the cell a quest split from", () => {
	it("takes an address of 1 to 32 ASCII letters or digits", () => {
		expect(splitFromOf("T")).toBe("T");
		expect(splitFromOf("tern02")).toBe("tern02");
		expect(splitFromOf("A".repeat(32))).toBe("A".repeat(32));
	});

	it("takes one with blanks round it, as a README may hold it", () => {
		expect(splitFromOf("  TERN02\n")).toBe("TERN02");
	});

	it("passes over what the node wouldn't take", () => {
		expect(splitFromOf(""), "empty").toBeUndefined();
		expect(splitFromOf("A".repeat(33)), "too long").toBeUndefined();
		expect(splitFromOf("TERN-02"), "a dash").toBeUndefined();
		expect(splitFromOf("TERN 02"), "a space within").toBeUndefined();
		expect(splitFromOf("TÉRN02"), "a letter outside ASCII").toBeUndefined();
		expect(splitFromOf(42), "not text").toBeUndefined();
		expect(splitFromOf(undefined), "nothing").toBeUndefined();
	});

	it("checks a seed's cell the same way, untrimmed", () => {
		expect(isCellAddress("TERN02")).toBe(true);
		expect(isCellAddress(" TERN02")).toBe(false);
	});
});
