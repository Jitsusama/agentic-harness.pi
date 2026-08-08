/**
 * One glyph, one meaning, across the whole package.
 *
 * These extensions run in one session. A mark that means two things in two
 * tools means neither, and the failure is silent: nothing errors, the screen
 * just stops being readable. Before this gate a filled diamond was both a
 * quest and a review finding, a hollow one both a sidequest and a verdict, and
 * a filled circle was both a review that landed and a working tree with
 * uncommitted changes in it, which is the best and the worst news on screen
 * wearing the same face.
 *
 * The families are allocated by domain: diamonds to quests, circle fills to
 * the TDD phase, squares to work, triangles to review.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A glyph, and the name some module knows it by. */
interface Use {
	glyph: string;
	name: string;
	where: string;
}

/**
 * Files that define glyphs for a user-facing surface.
 *
 * Named rather than discovered, because a gate whose scope is a pattern grows
 * a second list of exceptions the first time something legitimate matches it.
 */
const SURFACES = [
	"extensions/review-integration/render.ts",
	// Where the marks for anything spawned live, in neither of the two
	// surfaces that draw them. Review's round panel and the fleet's panel
	// both used to spell their own, which is how one of them ended up
	// drawing subagents in quest's diamonds without anything noticing:
	// this list is what notices, and that file was never in it.
	"lib/ui/agent-glyphs.ts",
	"extensions/work-integration/render.ts",
	"extensions/quest-workflow/render.ts",
	"extensions/tdd-workflow/glyphs.ts",
];

/** Which surface a file belongs to, for saying who is arguing with whom. */
function domainOf(path: string): string {
	return path.split("/")[1] ?? path;
}

/**
 * Glyphs that carry one meaning under more than one name.
 *
 * The check compares names, because meaning is not something a test can read.
 * Where two domains genuinely mean the same thing and only their vocabularies
 * differ, that is shared vocabulary rather than a collision, and it is listed
 * here with its reason instead of being silently tolerated.
 */
const SHARED: Record<string, string> = {
	"\u2298":
		"a refusal: review refuses an action, work refuses a repoint, a quest is blocked. One mark for no.",
	// Quest status and TDD phase are both a progress reading, and these two
	// land on the same sentiment in each: an open circle is early and moving,
	// a filled one is finished and good. Allowed deliberately rather than by
	// the check being unable to tell them apart, which is how it was allowed
	// before.
	"\u25cb": "early and in progress: a quest is active, a TDD loop is planning.",
	"\u25cf": "finished and good: a quest is concluded, a TDD loop is green.",
	"\u25d0":
		"half done: a quest is paused, and the TDD phases use the same fill series.",
};

/** A `\uXXXX` escape or a literal, as the character it means. */
function charOf(raw: string): string {
	return raw.startsWith("\\u")
		? String.fromCodePoint(Number.parseInt(raw.slice(2), 16))
		: raw;
}

/**
 * Every glyph a surface declares, under the name that means something.
 *
 * Two shapes are in use. A flat `name: "glyph"` map names the glyph directly.
 * A themed `name: { char: "glyph", token: "..." }` entry names it on the outer
 * key, and reading the inner one instead makes every themed glyph in the
 * package answer to `char`. That is not a cosmetic difference: the collision
 * check compares names, so a package-wide crop of glyphs all called `char`
 * agree with each other by construction and the check passes by being blind.
 * It did, and the overlap it could not see was the same filled circle for a
 * concluded quest and a passing test.
 */
function usesIn(path: string): Use[] {
	const source = readFileSync(path, "utf8");
	const found: Use[] = [];

	// Not-ascii is spelled as a positive range rather than a negated control
	// range, which the linter reads as a control character in a pattern.
	const themed =
		/([\w"-]+):\s*\{\s*char:\s*"((?:\\u[0-9a-fA-F]{4})|[\u0080-\uffff])"/g;
	for (const match of source.matchAll(themed)) {
		found.push({
			glyph: charOf(match[2] ?? ""),
			name: (match[1] ?? "").replaceAll('"', ""),
			where: path,
		});
	}

	const flat = /(\w+):\s*"((?:\\u[0-9a-fA-F]{4})|[\u0080-\uffff])"/g;
	for (const match of source.matchAll(flat)) {
		// The inner `char:` of a themed entry, already recorded by its key.
		if (match[1] === "char") continue;
		found.push({
			glyph: charOf(match[2] ?? ""),
			name: match[1] ?? "",
			where: path,
		});
	}
	return found;
}

/** Every glyph the named surfaces declare. */
function everyUse(): Use[] {
	return SURFACES.flatMap(usesIn);
}

describe("glyph ownership across the package", () => {
	it("finds the surfaces it means to check", async () => {
		// A gate reading nothing passes. This is the check that it read.
		const uses = everyUse();

		expect(uses.length).toBeGreaterThan(30);
		for (const surface of SURFACES) {
			expect(uses.some((use) => use.where === surface)).toBe(true);
		}
	});

	it("never gives one glyph two meanings in two domains", async () => {
		const byGlyph = new Map<string, Use[]>();
		for (const use of everyUse()) {
			byGlyph.set(use.glyph, [...(byGlyph.get(use.glyph) ?? []), use]);
		}

		const argued = [...byGlyph.entries()]
			.filter(([glyph]) => SHARED[glyph] === undefined)
			.filter(([, uses]) => {
				const domains = new Set(uses.map((use) => domainOf(use.where)));
				const names = new Set(uses.map((use) => use.name));
				return domains.size > 1 && names.size > 1;
			})
			.map(
				([glyph, uses]) =>
					`${glyph} is ${uses.map((use) => `${use.name} in ${domainOf(use.where)}`).join(", ")}`,
			);

		expect(argued).toEqual([]);
	});

	it("keeps each domain inside its own family", async () => {
		// The point of the allocation is that a glance tells you which tool is
		// talking before you have read a word of it.
		const family: Record<string, RegExp> = {
			// Triangles, plus the marks that are nobody else's. The reply arrow
			// is among them: a write gate has to hold what is about to be said
			// apart from the exchange quoted above it, and no triangle says
			// "this one is yours and it has not been sent yet".
			"review-integration":
				/[\u25b0-\u25bf\u2714\u2193\u2298\u25ce\u2261\u00b6\u276f\u2726\u2611\u2610\u2715\u21b3]/,
			// Squares, all of them, including the two describing what is inside
			// a tree rather than the tree itself. Plus the stack mark, which is
			// deliberately the review tools' own: a stack of branches and a stack
			// of changes are one idea seen from two sides.
			"work-integration": /[\u25a0-\u25af\u2298\u2026\u2261]/,
			// Diamonds for kind, and the circle statuses a quest has always had.
			"quest-workflow": /[\u25c0-\u25d5\u2297\u2298]/,
			// The circle-fill progression, a phase getting fuller, ending on a
			// centred circle for the refactor that follows green.
			"tdd-workflow": /[\u25c9\u25cb-\u25d5\u25cc]/,
			// Hexagons for how far along a spawned agent is, and marks rather
			// than shapes for how it ended, since those are two questions. The
			// family is its own because every other one is taken and a spawned
			// agent should read as neither a quest nor a review nor a tree.
			ui: /[\u2b21\u2b22\u2713\u2212\u2715]/,
		};

		const strays: string[] = [];
		for (const use of everyUse()) {
			const allowed = family[domainOf(use.where)];
			if (!allowed) continue;
			if (!allowed.test(use.glyph)) {
				strays.push(`${use.glyph} (${use.name}) in ${domainOf(use.where)}`);
			}
		}

		expect(strays).toEqual([]);
	});

	it("uses no glyph the terminal is guaranteed to draw double width", async () => {
		// An ambiguous-width glyph is one column in every terminal this
		// harness targets, and the quest surface has always used them. A
		// genuinely wide one would push every continuation line one column out
		// and misalign the whole listing.
		const wide = everyUse().filter((use) => {
			const at = use.glyph.codePointAt(0) ?? 0;
			return (
				(at >= 0x1100 && at <= 0x115f) ||
				(at >= 0x2e80 && at <= 0xa4cf) ||
				(at >= 0xff00 && at <= 0xff60) ||
				(at >= 0x1f300 && at <= 0x1f9ff)
			);
		});

		expect(wide.map((use) => `${use.glyph} ${use.name}`)).toEqual([]);
	});

	it("carries no emoji, since the harness is geometry", async () => {
		// Narrow on purpose. The dingbat block holds plenty of text-presentation
		// marks this surface uses on purpose (a chevron, a four-pointed star, a
		// ballot box), so a block-wide ban would flag the geometry it is meant
		// to protect. What is actually unwanted is anything the terminal draws
		// in colour at double width: the astral planes, and the handful of BMP
		// characters that default to emoji presentation.
		const EMOJI_BY_DEFAULT = new Set([
			0x26a0, 0x2705, 0x274c, 0x2757, 0x2b50, 0x2764, 0x2b55, 0x274e,
		]);
		const emoji = everyUse().filter((use) => {
			const at = use.glyph.codePointAt(0) ?? 0;
			return at >= 0x1f000 || EMOJI_BY_DEFAULT.has(at);
		});

		expect(emoji.map((use) => `${use.glyph} ${use.name}`)).toEqual([]);
	});

	it("is checking files that are actually tracked", async () => {
		// A renamed surface would otherwise take its glyphs out of scope and
		// the gate would keep passing.
		const tracked = execFileSync("git", ["ls-files", ...SURFACES], {
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => line !== "");

		expect(tracked.sort()).toEqual([...SURFACES].sort());
	});
});
