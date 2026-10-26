/**
 * A tool's name and its actions say the glossary's words, never a name it replaces.
 *
 * core.nix keeps the glossary: every thing its machines and their tooling hold, its one
 * word, and the names that word replaces. A tool's name and its actions are what agents
 * say all day and what the person reads in every gate, so they are held to it here,
 * through the matcher every repository shares (lib/glossary).
 *
 * The glossary is pinned beside this file, as core-glossary.txt, a plain copy so that this
 * repository's markdown gates do not read core's paths as its own. Refresh it with
 *
 *     git -C ~/src/core.nix show origin/main:docs/glossary.md > tests/package/core-glossary.txt
 *
 * and set PINNED to the commit it came from. Ordinary English uses most replaced names for
 * other things, so a name may be kept below as another sense, or as a rename still
 * waiting, each with why. A kept name no longer found, or one that no longer says a
 * replaced name, fails, so what's kept only shrinks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drift, readGlossary } from "../../lib/glossary/index.ts";
import { registered } from "./registered-tools.ts";

/** The core.nix commit core-glossary.txt was copied from. */
const PINNED = "556ad08346e6ab5a433803745656fd539ed2cfe0";

/** Names whose word means something the glossary doesn't replace, each with why. */
const OTHER_SENSE: Record<string, string> = {
	"browser_go storage": "a page's storage, not a disk",
	"quest drive": "driving is a quest's priority, not a disk",
};

/** Names waiting on a rename by the harness's owner, each with the rename. */
const WAITING: Record<string, string> = {
	cost: "cost to spend, AI spend's word",
	"quest tree-prune": "prune to release, as work already says",
};

const KEPT = [...Object.keys(OTHER_SENSE), ...Object.keys(WAITING)];

/** Every tool's name, and each of its actions after its name. */
function surface(): string[] {
	return [...registered()].flatMap(([tool, actions]) => [
		tool,
		...[...actions].map((action) => `${tool} ${action}`),
	]);
}

describe("a tool says the glossary's words", () => {
	const things = readGlossary(
		readFileSync(join(import.meta.dirname, "core-glossary.txt"), "utf8"),
	);

	it("reads the glossary it's pinned to", () => {
		// If this fails the copy is empty or its tables moved, and every other
		// assertion here would pass by finding nothing.
		expect(PINNED).toMatch(/^[0-9a-f]{40}$/);
		expect(
			things.find((thing) => thing.word === "release")?.replaces,
		).toContain("prune");
	});

	it("names no tool or action with a name the glossary replaces", () => {
		expect(drift(things, surface(), KEPT)).toEqual([]);
	});

	it("keeps only names that still say a replaced name", () => {
		const stale = KEPT.filter((name) => drift(things, [name], []).length === 0);
		expect(stale, "kept but saying no replaced name: take them off").toEqual(
			[],
		);
	});
});
