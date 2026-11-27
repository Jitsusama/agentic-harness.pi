/**
 * The words that say nothing about any work, left out of what a need and
 * a cell's title are matched by. On 24 November one need went to a cell
 * by "under" alone and another by "across", and each found cell answered
 * that the work wasn't its own.
 */

import { describe, expect, it } from "vitest";
import {
	foragersFrom,
	LONGEST_WORD,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
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

	it("reads no id from a contraction's stub and the number after it", () => {
		const words = wordsOf("it's 5 now, and it\u2019s 6, though 'PR 42' holds");

		expect(words, "no stub's id").not.toContain("s-5");
		expect(words, "none past a curly apostrophe").not.toContain("s-6");
		expect(words, "an id after an opening quote").toContain("pr-42");
	});

	it("reads an apostrophe's look-alikes as one", () => {
		expect(
			wordsOf("it\u02BCs 5, it\u00B4s 6, it\u2018s 7, don\u02BCt"),
			"no stub's id, and no contraction kept whole",
		).toEqual([]);
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

	it("keeps no phrase whose first word names no work", () => {
		expect(wordsOf("them off the notes"), "a common word's").toEqual(["notes"]);
		expect(wordsOf("go up"), "a short word's").toEqual([]);
	});

	// A phrase says its first word again: hand-over is work on hand. So a
	// cell whose title says find out, and nothing else of the need, works
	// on one of its words, not two (#2220's third judge).
	it("counts a phrase and its first word as one word of the need", () => {
		const found = routeNeed(
			asked("A", ...wordsOf("find out who keeps the launcher fonts")),
			{
				foragers: cells({
					A: [],
					T: ["find", "find-out"],
					R: ["launcher", "fonts"],
				}),
				ties: ties(["A", "T", 1], ["A", "R", 1]),
				hubs: [],
			},
		);

		expect(found, "the cell working on the fonts").toMatchObject({
			fit: "R",
		});
	});

	// Each covers one word the need lacks, and R doesn't work on find, so
	// T's find out says nothing more against it: neither outranks the
	// other, and the first found takes it (#2220's seventh round, F61).
	// Words held as often are walked in their sorting order, so R's word
	// is tried both before find (docs) and after it (zines): a tie follows
	// that order, where a phrase counted against R gives T both times
	// (round 7b, F74 and F76).
	const findOut = (word: string, live: (address: string) => boolean) =>
		routeNeed(asked("A", ...wordsOf(`find out who keeps the ${word}`)), {
			foragers: cells({ A: [], T: ["find", "find-out"], R: [word] }),
			ties: ties(["A", "T", 1], ["A", "R", 1]),
			hubs: [],
			live,
		});

	it("lets no phrase outrank a cell holding none of its first word", () => {
		expect(
			[findOut("docs", () => true).fit, findOut("zines", () => true).fit],
			"a tie, taken by whichever is found first",
		).toEqual(["R", "T"]);
	});

	it("names no ended owner by a phrase whose first word the fit doesn't work on", () => {
		const live = (address: string) => address !== "T";

		expect(
			[findOut("docs", live).fit, findOut("zines", live).fit],
			"the live cell each time, not lost to T",
		).toEqual(["R", "R"]);
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

	// Each cell covers a need saying hand over by hand alone, so only the
	// phrase tells them apart, and a hub's find goes first (#2220's fourth
	// judge, F13).
	it("sends a need saying hand over to the cell holding the phrase, not a hub's hand-off fit", () => {
		const found = routeNeed(asked("A", ...wordsOf("hand over the notes")), {
			foragers: cells({
				A: [],
				X: ["hand", "hand-over"],
				Y: ["hand", "hand-off"],
			}),
			ties: ties(["A", "X", 1]),
			hubs: [{ subject: "x:hand-off", hub: "Y", fits: ["Y"] }],
		});

		expect(found, "the hand-over cell").toMatchObject({ fit: "X" });
	});

	it("counts the phrase of a cell when the asker holds its first word", () => {
		// F lacks for nothing N does, so only the phrase makes it the need's
		// owner; uncounted, the two tie and live N takes it, in whatever
		// order they are found (round 7b, F76).
		const found = routeNeed(asked("A", ...wordsOf("hand over the notes")), {
			foragers: cells({
				A: ["hand"],
				F: ["hand", "hand-over", "notes"],
				N: ["notes"],
			}),
			ties: ties(["A", "N", 1], ["A", "F", 1]),
			hubs: [],
			live: (address) => address !== "F",
		});

		expect(found, "owned by the cell holding the phrase").toMatchObject({
			fit: null,
			ended: ["F"],
			fellShort: "N",
		});
	});

	it("says an ended hand-over cell owned a need a live hand-off cell would take", () => {
		const found = routeNeed(asked("A", ...wordsOf("hand over the notes")), {
			foragers: cells({
				A: [],
				X: ["hand", "hand-over"],
				Y: ["hand", "hand-off"],
			}),
			ties: ties(["A", "Y", 1], ["A", "X", 1]),
			hubs: [],
			live: (address) => address !== "X",
		});

		expect(found, "lost, with its owner named").toMatchObject({
			fit: null,
			ended: ["X"],
			fellShort: "Y",
		});
	});

	// The live cell holds all the ended one does, and hand besides, so
	// the phrase tells them apart in nothing (#2220's round 7b, F81).
	it("names no ended owner by a phrase the live fit holds too", () => {
		const found = routeNeed(asked("A", ...wordsOf("hand over the notes")), {
			foragers: cells({ A: [], E: ["hand-over"], L: ["hand", "hand-over"] }),
			ties: ties(["A", "L", 1], ["A", "E", 1]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found, "delivered to the live cell, not lost to E").toMatchObject({
			fit: "L",
		});
		expect(found.ended, "no ended owner named").toBeUndefined();
	});

	// Each fit of the pallets hub covers two words the asker lacks. H's
	// phrase tells it from B, N holds more of the whole need than H, and
	// B more than N: weighed pair by pair they went round, so which took
	// it hung on the order the hub listed them in (#2220's round 7b, F78).
	// Weighed as one lot, H's phrase counts against B, and H takes it.
	it("finds the same fit whatever order a hub lists its fits in", () => {
		const need = asked("A", ...wordsOf("hand over the notes, foo bar pallets"));
		const foragers = cells({
			A: ["foo", "bar"],
			P: ["pallets"],
			H: ["hand", "hand-over", "pallets"],
			B: ["hand", "foo", "bar", "pallets"],
			N: ["notes", "foo", "pallets"],
		});
		const fits = [
			["H", "B", "N"],
			["B", "N", "H"],
			["N", "H", "B"],
		].map(
			(order) =>
				routeNeed(need, {
					foragers,
					ties: ties(),
					hubs: [{ subject: "x:pallets", hub: "P", fits: order }],
				}).fit,
		);

		expect(fits, "H in every order").toEqual(["H", "H", "H"]);
	});

	it("reads no phrase from a cell's title, but keeps a subject's", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "cell:SSHSYN", title: "Sync over SSH" },
				{ key: "cell:HANDOV", title: "Notes", subjects: ["x:hand-over"] },
			],
		});
		const [titled, declared] = foragersFrom(line);

		// Over in a title is most often a preposition, so Sync over SSH
		// outweighs no cell on sync for a need saying sync over wifi
		// (#2220's round 7b, F79).
		expect(titled?.words, "the title's words, no phrase").toEqual([
			"sync",
			"ssh",
		]);
		expect(declared?.words, "the subject's phrase kept").toContain("hand-over");
	});

	it("keeps an id as long as LONGEST_WORD, and none longer", () => {
		const id = `leg-${"p".repeat(LONGEST_WORD - 4)}`;

		expect(wordsOf(id), "at the cap").toContain(id);
		expect(wordsOf(`${id}p`), "past it").not.toContain(`${id}p`);
	});

	// A common word before a phrase's head leaves the phrase whole
	// (#2220's fifth council, F6).
	it("reads a phrase after a common word", () => {
		expect(wordsOf("please back up the database")).toContain("back-up");
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
