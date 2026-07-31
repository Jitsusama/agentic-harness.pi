/**
 * A tilde is a courtesy, and the courtesy has to be safe.
 *
 * Every case here is a way this could quietly say the wrong place, which is worse
 * than a long path: a reader who cannot tell `~.backup` from `~/.backup` has been
 * shown a directory that does not exist.
 */

import { describe, expect, it } from "vitest";
import { displayPath } from "../../../lib/ui/path.js";

const HOME = "/Users/somebody";

describe("writing a path the way a person says it", () => {
	it("writes the home directory as a tilde", () => {
		expect(displayPath(`${HOME}/src/thing/lib/work.ts`, HOME)).toBe(
			"~/src/thing/lib/work.ts",
		);
	});

	it("writes home itself as a bare tilde", () => {
		expect(displayPath(HOME, HOME)).toBe("~");
	});

	it("leaves a relative path alone", () => {
		// What makes this safe to apply to a list that mixes absolute tree paths
		// with repo-relative file paths, which the status listing does.
		expect(displayPath("lib/work/tree.ts", HOME)).toBe("lib/work/tree.ts");
	});

	it("leaves a path outside home alone", () => {
		expect(displayPath("/var/folders/xb/scratch", HOME)).toBe(
			"/var/folders/xb/scratch",
		);
	});

	it("does not abbreviate a sibling whose name merely starts with home's", () => {
		// The one that matters. Without requiring the separator this reads as
		// `~.backup`, which looks like a file inside home and is a different
		// place entirely.
		expect(displayPath(`${HOME}.backup/src`, HOME)).toBe(`${HOME}.backup/src`);
	});

	it("does not touch a home directory mentioned in the middle", () => {
		// Only a prefix is a home directory; anywhere else it is a coincidence,
		// and rewriting it would corrupt the path.
		const nested = `/tmp/archive${HOME}/old`;

		expect(displayPath(nested, HOME)).toBe(nested);
	});

	it("copes with a trailing separator on home", () => {
		expect(displayPath(`${HOME}/src`, `${HOME}/`)).toBe("~/src");
	});

	it("changes nothing when there is no home to speak of", () => {
		// An empty home would otherwise turn every path into a tilde, which
		// happens on a machine with no HOME set rather than never.
		expect(displayPath("/Users/somebody/src", "")).toBe("/Users/somebody/src");
	});
});
