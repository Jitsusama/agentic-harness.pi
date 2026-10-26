/**
 * A tool's name and its actions say the glossary's words, never a name it replaces.
 *
 * core.nix keeps the glossary: every thing on Joel's machines and in their tooling, its
 * one word, and the names that word replaces. Joel has a poor memory, and two names for
 * one thing cost him every time he meets them, so a replaced name is never written, shown
 * or found. A tool's name and its actions are what agents say all day and what Joel reads
 * in every gate, so they are held to it here.
 *
 * The glossary is pinned beside this file, as core-glossary.txt, a plain copy so that this
 * repository's markdown gates do not read core's paths as its own. Refresh it with
 *
 *     git -C ~/src/core.nix show origin/main:docs/glossary.md > tests/package/core-glossary.txt
 *
 * and set PINNED to the commit it came from. Words are matched as core's tests/names.py
 * matches them: a name is split at underscores, hyphens and capitals, a plural counts as
 * its word, a replaced name inside a longer term passes ("line" inside "status line"), and
 * so does one the glossary spells on its own in code. Ordinary English uses most replaced
 * names for other things, so a name may also be listed below as another sense, or as a
 * rename still waiting, each with why; a listed name no longer found fails, so the lists
 * only shrink.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registered } from "./registered-tools.ts";

/** The core.nix commit core-glossary.txt was copied from. */
const PINNED = "71683682816d9570a35d7d5c57a4e26b97f1639e";

/** Names whose word means something the glossary doesn't replace, each with why. */
const OTHER_SENSE: Record<string, string> = {
	"browser_go storage": "a page's storage, not a disk",
	"quest drive": "driving is a quest's priority, not a disk",
	"work resume": "resuming a halted rebase, not waking from sleep",
};

/** Names waiting on a rename by the harness's owner, each with the rename. */
const WAITING: Record<string, string> = {
	cost: "cost to spend, AI spend's word",
	"quest tree-prune": "prune to release, as work already says",
};

/** One row of the glossary: its word, the names it replaces, and how code spells it. */
interface Thing {
	word: string;
	replaces: string[];
	code: string;
}

/** Every row of the glossary's word tables, in any context. */
function readGlossary(text: string): Thing[] {
	const things: Thing[] = [];
	let columns: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trimStart().startsWith("|")) {
			columns = [];
			continue;
		}
		const cells = line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((cell) => cell.trim());
		if (cells.join("").replace(/[-: ]/g, "") === "") continue;
		if (columns.length === 0) {
			columns = cells;
			continue;
		}
		if (columns[0] !== "Word" || cells.length !== columns.length) continue;
		const at = (name: string) => cells[columns.indexOf(name)] ?? "";
		things.push({
			word: at("Word").toLowerCase(),
			replaces: at("Not")
				.split(",")
				.map((word) => word.trim().toLowerCase())
				.filter((word) => word !== ""),
			code: at("In code"),
		});
	}
	return things;
}

/** A name or a term split into its words, in lower case. */
function tokens(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((word) => word !== "");
}

/** Whether words say old, a plural counting as its word. */
function same(words: string[], old: string[]): boolean {
	return (
		words.length === old.length &&
		words.every((word, at) =>
			[old[at], `${old[at]}s`, `${old[at]}es`].includes(word),
		)
	);
}

/** Whether a longer term covers the words from start, as status line covers line. */
function held(
	words: string[],
	start: number,
	length: number,
	terms: string[][],
): boolean {
	return terms.some((term) => {
		if (term.length <= length) return false;
		for (
			let at = Math.max(0, start + length - term.length);
			at <= start;
			at++
		) {
			if (same(words.slice(at, at + term.length), term)) return true;
		}
		return false;
	});
}

/** Each name the glossary replaces that a name says, with the word that replaces it. */
function replaced(name: string, things: Thing[]): string[] {
	const words = tokens(name);
	const terms = things.map((thing) => tokens(thing.word));
	const code = things.flatMap((thing) =>
		[...thing.code.matchAll(/`([^`]+)`/g)].map(([, span]) => tokens(span)),
	);
	const out: string[] = [];
	for (const thing of things) {
		for (const old of thing.replaces) {
			const oldWords = tokens(old);
			if (code.some((span) => same(span, oldWords))) continue;
			for (let start = 0; start + oldWords.length <= words.length; start++) {
				if (!same(words.slice(start, start + oldWords.length), oldWords))
					continue;
				if (!held(words, start, oldWords.length, terms)) {
					out.push(
						`"${name}" says "${old}", which the glossary calls "${thing.word}".`,
					);
				}
			}
		}
	}
	return out;
}

/** Each name that says a replaced name, and each listed name no longer found. */
function drift(things: Thing[], names: string[]): string[] {
	const kept = new Set([...Object.keys(OTHER_SENSE), ...Object.keys(WAITING)]);
	const out = names
		.filter((name) => !kept.has(name))
		.flatMap((name) => replaced(name, things));
	for (const name of kept) {
		if (!names.includes(name)) {
			out.push(`"${name}" is listed here but no longer found: take it off.`);
		}
	}
	return out;
}

/** Every tool's name, and each of its actions after its name. */
function surface(): string[] {
	return [...registered()].flatMap(([tool, actions]) => [
		tool,
		...[...actions].map((action) => `${tool} ${action}`),
	]);
}

const STAND_IN = readGlossary(
	[
		"## Network",
		"",
		"| Word | Means | Not | In code |",
		"| --- | --- | --- | --- |",
		"| connection | the link out | line | |",
		"| status line | the line under a session | status bar | |",
		"| person | the human | user | |",
		"| brightness | how bright a screen is | | the `backlight` program |",
		"| light | the keyboard's light | backlight | |",
	].join("\n"),
);

const LISTED = [...Object.keys(OTHER_SENSE), ...Object.keys(WAITING)];

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
		expect(drift(things, surface())).toEqual([]);
	});

	it.each([
		["a replaced name in a tool's name", "user_lookup"],
		["a replaced name in an action", "mesh lines"],
		["a replaced name made plural", "people users"],
	])("refuses %s", (_, name) => {
		expect(drift(STAND_IN, [name, ...LISTED])).not.toEqual([]);
	});

	it("refuses a listed name that is no longer found", () => {
		expect(drift(STAND_IN, LISTED.slice(1))).not.toEqual([]);
	});

	it("lets through a replaced name inside a term, in code, or inside another word", () => {
		const beside = ["the_status_line", "backlight", "userspace", ...LISTED];
		expect(drift(STAND_IN, beside)).toEqual([]);
	});
});
