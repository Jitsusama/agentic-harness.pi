/**
 * The glossary matcher refuses each replaced name it is there to refuse and lets through
 * what sits beside each rule's edge, against a stand-in glossary, so a repository's own
 * names test proves only its names and what it keeps.
 */

import { describe, expect, it } from "vitest";
import { drift, readGlossary } from "../../../lib/glossary/index.ts";

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
		"| filling | a disk filling up | pressure | `pressure` |",
		"",
		"Prose between tables is not a row.",
		"",
		"| Quest | Short name |",
		"| --- | --- |",
		"| line | not a word table |",
	].join("\n"),
);

/** A stand-in kept name, beside every case, so that what's kept isn't what fails. */
const KEPT = ["mesh_line_kept"];

describe("the glossary matcher", () => {
	it("reads only the word tables' rows", () => {
		expect(STAND_IN.map((thing) => thing.word)).toEqual([
			"connection",
			"status line",
			"person",
			"brightness",
			"light",
			"filling",
		]);
		expect(STAND_IN[0].replaces).toEqual(["line"]);
	});

	it.each([
		["a replaced name in a tool's name", "user_lookup"],
		["a replaced name in an action", "mesh lines"],
		["a replaced name made plural", "people users"],
		["a replaced name in camel case", "lineRate"],
		["a replaced name another row spells as code", "keyboard_backlight"],
	])("refuses %s", (_, name) => {
		expect(drift(STAND_IN, [name, ...KEPT], KEPT)).not.toEqual([]);
	});

	it("refuses a kept name that is no longer found", () => {
		expect(drift(STAND_IN, [], KEPT)).toEqual([
			'"mesh_line_kept" is kept but no longer found: take it off.',
		]);
	});

	it("lets through a replaced name inside a term, in its own row's code, or inside another word", () => {
		const beside = ["the_status_line", "pressure_band", "userspace", ...KEPT];
		expect(drift(STAND_IN, beside, KEPT)).toEqual([]);
	});

	it("says which word replaces the name", () => {
		expect(drift(STAND_IN, ["user_lookup"], [])).toEqual([
			'"user_lookup" says "user", which the glossary calls "person".',
		]);
	});
});
