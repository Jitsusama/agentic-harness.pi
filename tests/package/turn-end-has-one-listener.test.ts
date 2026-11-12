/**
 * Every extension hears a turn's end through the one listener.
 *
 * pi rebuilds the whole context a boundary handler could see after
 * each `turn_end` listener, whatever it returned, so every listener an
 * extension adds of its own holds pi's main thread once more each tool
 * round: 10 to 40 ms on a long session, while keys wait (plan item
 * 191). `onTurnEnd` (`lib/internal/session/turn-end.ts`) gathers the
 * harness's handlers under one; this keeps a new one from listening
 * beside it, where nothing else would notice the cost.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEARCHED = ["extensions", "packs", "lib"];
const THE_LISTENER = "lib/internal/session/turn-end.ts";
const OWN_LISTENER = /\.on\(\s*["'`]turn_end["'`]/;

function sources(folder: string): string[] {
	return readdirSync(join(ROOT, folder), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && /\.(ts|mts|mjs)$/.test(entry.name))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

describe("a turn's end", () => {
	it("is heard through onTurnEnd, never by a listener of an extension's own", () => {
		const own = SEARCHED.flatMap(sources).filter(
			(file) =>
				file !== THE_LISTENER &&
				OWN_LISTENER.test(readFileSync(join(ROOT, file), "utf8")),
		);

		expect(own, "files listening for turn_end beside onTurnEnd").toEqual([]);
	});
});
