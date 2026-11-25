/**
 * The words that say nothing about any work, left out of what a need and
 * a cell's title are matched by. On 24 November one need went to a cell
 * by "under" alone and another by "across", and each found cell answered
 * that the work wasn't its own.
 */

import { describe, expect, it } from "vitest";
import { foragersFrom, wordsOf } from "../../../lib/mesh/need-route.ts";
import { asked, cells, routeNeed, ties } from "./support/needs.ts";

describe("the plain words a need is not matched by", () => {
	it("leaves out prepositions, pronouns and helping verbs", () => {
		expect(
			wordsOf(
				"Who owns the gate across the realm under load, and which cell should I ask about it?",
			),
			"only the words of the work",
		).toEqual(["owns", "gate", "realm", "load", "cell", "ask"]);
	});

	it("reads no id from a plain word and the number after it", () => {
		const words = wordsOf("busiest five under 15 and all 3 of them");

		expect(words, "a number after a plain word").not.toContain("under-15");
		expect(words, "a number after a common word").not.toContain("all-3");
		expect(
			wordsOf("due on 24, in 15 or at 3"),
			"a number after a word too short to be one",
		).toEqual(["due"]);
		expect(words, "the work's own words").toEqual(
			expect.arrayContaining(["busiest", "five"]),
		);
	});

	it("keeps a plain word inside an id, which names the work whole", () => {
		expect(wordsOf("hand-over"), "the id kept").toContain("hand-over");
	});

	it("takes a hub whose subject's other part is a plain word by its work part alone", () => {
		// over names no work, so a need saying hand says all hand-over
		// does; a need saying lines still isn't pallet-lines's. No ties, so
		// only a hub carries a need anywhere.
		const reach = {
			foragers: cells({ A: [], H: ["hand"], P: ["pallet", "lines"] }),
			ties: ties(),
			hubs: [
				{ subject: "x:hand-over", hub: "H", fits: ["H"] },
				{ subject: "x:pallet-lines", hub: "P", fits: ["P"] },
			],
		};

		expect(
			routeNeed(asked("A", "hand"), reach),
			"hand-over's hub takes it",
		).toMatchObject({ fit: "H", path: ["H"] });
		expect(
			routeNeed(asked("A", "lines"), reach).fit,
			"pallet-lines's hub doesn't",
		).toBeNull();
	});

	it("takes no plain word from a cell's title", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "cell:1DZYLJ", title: "Dates Under Review Across Quests" },
			],
		});

		expect(foragersFrom(line)[0]?.words, "the title's work alone").toEqual([
			"dates",
			"review",
			"quests",
		]);
	});

	it("finds no cell by a plain word only its title holds", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "cell:AAAAAA", title: "Asker" },
				{ key: "cell:1DZYLJ", title: "Dates Under Review" },
			],
		});

		// The need's words as given, under among them, so only the title's
		// leaving it out keeps the need from 1DZYLJ.
		const found = routeNeed(
			{ ...asked("AAAAAA", "under", "carry"), fromText: true },
			{
				foragers: foragersFrom(line),
				ties: ties(["AAAAAA", "1DZYLJ", 3]),
				hubs: [],
			},
		);

		expect(found.fit, "lost, rather than sent to a cell by under").toBeNull();
	});
});
