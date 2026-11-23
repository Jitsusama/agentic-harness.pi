/**
 * Which characters draw as nothing: every format character, and the
 * others the node counts as unseen, but never a letter or a mark that
 * draws on the letter before it.
 */

import { describe, expect, it } from "vitest";
import { drawsAsNothing } from "../../../lib/internal/unseen.ts";

describe("drawsAsNothing", () => {
	it("counts every format character", () => {
		for (const each of ["\u200B", "\u202E", "\u2066", "\uFEFF", "\u{E0041}"]) {
			expect(drawsAsNothing(each), JSON.stringify(each)).toBe(true);
		}
	});

	it("counts what the node calls unseen beyond them, at each end of its ranges", () => {
		for (const point of [
			0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2065, 0x3164,
			0xfe00, 0xfe0f, 0xffa0, 0xe007f, 0xe0100, 0xe01ef,
		]) {
			expect(
				drawsAsNothing(String.fromCodePoint(point)),
				point.toString(16),
			).toBe(true);
		}
	});

	it("never counts what draws: a letter, an emoji, an accent on its letter", () => {
		for (const each of ["a", "\u00E9", "\u{1F600}", "\u0301", " ", "\u3163"]) {
			expect(drawsAsNothing(each), JSON.stringify(each)).toBe(false);
		}
	});
});
