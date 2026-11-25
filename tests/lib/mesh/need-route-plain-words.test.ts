/**
 * The words that say nothing about any work, left out of what a need and
 * a cell's title are matched by. On 24 November one need went to a cell
 * by "under" alone and another by "across", and each found cell answered
 * that the work wasn't its own.
 */

import { describe, expect, it } from "vitest";
import { foragersFrom, wordsOf } from "../../../lib/mesh/need-route.ts";
import { asked, routeNeed, ties } from "./support/needs.ts";

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
		expect(words, "the work's own words").toEqual(
			expect.arrayContaining(["busiest", "five"]),
		);
	});

	it("keeps a plain word inside an id, which names the work whole", () => {
		expect(wordsOf("hand-over"), "the id kept").toContain("hand-over");
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

	it("finds no cell for a need whose only shared word is a plain one", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "cell:AAAAAA", title: "Asker" },
				{ key: "cell:1DZYLJ", title: "Dates Under Review" },
			],
		});

		const found = routeNeed(
			{ ...asked("AAAAAA", ...wordsOf("still under it")), fromText: true },
			{
				foragers: foragersFrom(line),
				ties: ties(["AAAAAA", "1DZYLJ", 3]),
				hubs: [],
			},
		);

		expect(found.fit, "lost, rather than sent to a cell by under").toBeNull();
	});
});
