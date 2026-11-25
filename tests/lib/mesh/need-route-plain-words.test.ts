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

	it("reads an id from a short word of work and the number after it", () => {
		const words = wordsOf("PR 42 fails on v 2 and I 5, due on 24");

		expect(words, "a pull request, a version and a spirit property").toEqual(
			expect.arrayContaining(["pr-42", "v-2", "i-5"]),
		);
		expect(words, "a number after a short plain word").not.toContain("on-24");
	});

	it("takes no word from a contraction's stubs", () => {
		expect(
			wordsOf("don't, isn't, won't, can't, shouldn't, didn't, wasn't"),
			"nothing of the work",
		).toEqual([]);
	});

	it("keeps a word and the particle after it as one id", () => {
		expect(wordsOf("Hand over the notes"), "the phrase whole").toEqual([
			"hand",
			"notes",
			"hand-over",
		]);
		expect(wordsOf("over the notes"), "a particle alone").toEqual(["notes"]);
	});

	it("sends a need saying hand over to hand-over's hub, not hand-off's", () => {
		// over and off name no work alone, so without the phrase both hubs
		// say all the need does. No ties, so only a hub carries it.
		const reach = {
			foragers: cells({ A: [], O: ["hand"], F: ["hand"] }),
			ties: ties(),
			hubs: [
				{ subject: "x:hand-off", hub: "F", fits: ["F"] },
				{ subject: "x:hand-over", hub: "O", fits: ["O"] },
			],
		};

		expect(
			routeNeed(asked("A", ...wordsOf("hand over the notes")), reach),
			"hand-over's hub takes it",
		).toMatchObject({ fit: "O", path: ["O"] });
		expect(
			routeNeed(asked("A", ...wordsOf("hand off the notes")), reach),
			"hand-off's hub takes the other",
		).toMatchObject({ fit: "F", path: ["F"] });
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
		const reach = {
			foragers: foragersFrom(line),
			ties: ties(["AAAAAA", "1DZYLJ", 3]),
			hubs: [],
		};

		expect(
			routeNeed(asked("AAAAAA", "under", "carry"), reach).fit,
			"lost, rather than sent to a cell by under",
		).toBeNull();
		expect(
			routeNeed(asked("AAAAAA", "dates", "carry"), reach).fit,
			"found by a word of its work",
		).toBe("1DZYLJ");
	});
});
