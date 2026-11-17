/**
 * How the supervisor cuts text to what it keeps. Each cut is measured
 * in bytes where a file or a result has a byte cap, so a multi-byte
 * character must never be split.
 */

import { describe, expect, it } from "vitest";
import {
	errorCode,
	tail,
	trim,
	truncate,
	truncateBytes,
} from "../../../../lib/subagent/runpi/supervisor-text.mjs";

describe("cutting text", () => {
	it("leaves text within its bytes alone, and says nothing", () => {
		const warned: string[] = [];
		expect(truncateBytes("ééé", 6, (said) => warned.push(said))).toBe("ééé");
		expect(warned).toEqual([]);
	});

	it("keeps the end of stderr that fits, whole characters only", () => {
		expect(tail("abc", 3)).toBe("abc");
		expect(tail("aéé", 3), "one é is two bytes").toBe("é");
		expect(tail("abcdef", 2)).toBe("ef");
		expect(tail("abc", 2), "all but the first character fits").toBe("bc");
		expect(tail("a😀", 4), "an emoji is four bytes").toBe("😀");
		expect(tail("é😀", 5), "never half an é").toBe("😀");
	});

	it("marks a stream line cut to a glance", () => {
		expect(truncate("abcdef", 3)).toBe("abc...");
		expect(truncate("abc", 3)).toBe("abc");
	});

	it("puts an argument on one line, cut with an ellipsis", () => {
		expect(trim("  a\n\tb  ", 10)).toBe("a b");
		expect(trim("abcdef", 4)).toBe("abc…");
	});

	it("names a failed read by its code where it has one", () => {
		expect(errorCode(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
			"EACCES",
		);
		expect(errorCode("plain")).toBe("plain");
	});
});
