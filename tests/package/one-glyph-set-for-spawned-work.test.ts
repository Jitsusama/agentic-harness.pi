/**
 * Everything that spawns an agent draws it the same way.
 *
 * A fan-out and a review round are the same kind of event on screen:
 * several models sent away at once, each in one of five states. They
 * were drawn in two vocabularies that had never been compared, and
 * both had gone wrong in the way the ownership gate exists to catch.
 *
 * The fleet drew a pending subagent as a hollow diamond and a running
 * one as a filled one, which are precisely the marks quests use for a
 * sidequest and a subquest. Review had already been bitten by that and
 * had moved off diamonds, saying so in a comment; the fleet's copy was
 * never in the gate's list, so nothing noticed it doing the same thing.
 * Review then had no cancelled state at all, so a reviewer somebody
 * stopped kept the mark and the colour of one that answered.
 *
 * So the rule is one set, owned in one place, and no surface spelling
 * a mark of its own.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_GLYPH } from "../../lib/ui/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Surfaces that draw spawned work and must not spell a mark of their own.
 *
 * Named rather than discovered, for the reason the ownership gate gives:
 * a scope that is a pattern grows an exception list the first time
 * something legitimate matches it.
 */
const DRAWS_SPAWNED_WORK = [
	"extensions/subagent-workflow/progress-render.ts",
	"extensions/review-integration/progress.ts",
];

/** The five states anything spawned can be in. */
const STATES = ["pending", "running", "done", "cancelled", "failed"] as const;

describe("one glyph set for spawned work", () => {
	it("names every state an agent can be in", () => {
		expect(Object.keys(AGENT_GLYPH).sort()).toEqual([...STATES].sort());
	});

	it("gives each state a mark of its own", () => {
		const marks = STATES.map((state) => AGENT_GLYPH[state]);

		expect(new Set(marks).size).toBe(STATES.length);
	});

	it("uses no mark another domain owns", () => {
		// The two that bit: quests own the diamonds, and the fleet was
		// drawing a pending subagent as a sidequest and a running one as
		// a subquest.
		const owned = new Set(["\u25c6", "\u25c7", "\u25c8", "\u25c9"]);

		for (const state of STATES) {
			expect(owned.has(AGENT_GLYPH[state])).toBe(false);
		}
	});

	it("is drawn from, never copied, by the surfaces that spawn work", () => {
		// The gate that makes this a rule rather than a coincidence. A
		// surface reaching for its own literal is how the two vocabularies
		// drifted apart in the first place, and it costs nothing to say so
		// here instead of finding it on screen.
		for (const surface of DRAWS_SPAWNED_WORK) {
			const source = readFileSync(join(ROOT, surface), "utf8");

			expect(source).toContain("AGENT_GLYPH");
			// The five marks themselves, spelled either way a glyph gets
			// written here: as the character, or as its escape. Other marks
			// in these files are rules, arrows and key hints, which are not
			// states and are nobody's family.
			const spelled = STATES.flatMap((state) => {
				const mark = AGENT_GLYPH[state];
				const written = `\\u${mark.codePointAt(0)?.toString(16).padStart(4, "0")}`;
				return source.includes(mark) || source.includes(written) ? [state] : [];
			});
			expect({ surface, spelled }).toEqual({ surface, spelled: [] });
		}
	});
});
