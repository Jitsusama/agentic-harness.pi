/**
 * A need found by the id a cell holds as its resident need: a spirit
 * property, a leg, a seam or a zone, each kept whole beside its words,
 * since split into words I-5 gives none and a seam's folder gives words
 * half the realm holds (IKQ63G's forms, 21 November).
 */

import { describe, expect, it } from "vitest";
import {
	foragersFrom,
	subjectWords,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
import { asked, cells, routeNeed, ties } from "./support/needs.ts";

describe("the ids a need or a cell's work is matched by", () => {
	it("keeps a spirit property whole, which its words alone lose", () => {
		expect(wordsOf("I-5 fails at the candidate"), "I-5 kept").toEqual([
			"fails",
			"candidate",
			"i-5",
		]);
		expect(wordsOf("XIII-2"), "a longer numeral kept whole").toEqual([
			"xiii",
			"xiii-2",
		]);
	});

	it("keeps a seam's folder and a zone whole beside their words", () => {
		expect(wordsOf("node_kubelet_cri"), "a seam's folder").toEqual([
			"node",
			"kubelet",
			"cri",
			"node_kubelet_cri",
		]);
		expect(wordsOf("cert-request"), "a zone's name").toEqual([
			"cert",
			"request",
			"cert-request",
		]);
	});

	it("reads a leg named in prose as its id, as the id itself is read", () => {
		expect(wordsOf("Leg 26 is red"), "leg in prose").toContain("leg-26");
		expect(wordsOf("leg-26"), "the id as written").toContain("leg-26");
	});

	it("keeps a CamelCase spec node one word, as it always was", () => {
		expect(wordsOf("NodeKubeletCriSeam"), "one word").toEqual([
			"nodekubeletcriseam",
		]);
	});

	it("gives a declared subject's narrowest part its id", () => {
		expect(subjectWords("aquifer:I-5"), "a property subject").toEqual(["i-5"]);
		expect(subjectWords("platform/cert-request"), "a zone subject").toEqual([
			"cert",
			"request",
			"cert-request",
		]);
	});
});

describe("a need for the id a cell holds", () => {
	it("reaches the cell declaring a spirit property, which no word of it named before", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "cell:P5", title: "Article I", subjects: ["aquifer:I-5"] },
				{ key: "cell:Q9", title: "Article I", subjects: ["aquifer:I-6"] },
			],
		});
		const need = asked("A", ...wordsOf("I-5 fails at the candidate"));

		const found = routeNeed(
			{ ...need, fromText: true },
			{
				foragers: [...cells({ A: [] }), ...foragersFrom(line)],
				ties: ties(["A", "Q9", 2], ["A", "P5", 1]),
				hubs: [],
			},
		);

		expect(found, "the holder of I-5, not of I-6").toMatchObject({
			fit: "P5",
			words: ["i-5"],
		});
	});

	it("reaches the holder of the leg named, past a stronger tie to another leg's", () => {
		const found = routeNeed(
			{ ...asked("A", ...wordsOf("Leg 26 is red")), fromText: true },
			{
				foragers: cells({
					A: [],
					L27: wordsOf("leg-27"),
					L26: wordsOf("leg-26"),
				}),
				ties: ties(["A", "L27", 2], ["A", "L26", 1]),
				hubs: [],
			},
		);

		expect(found, "leg 26's holder").toMatchObject({ fit: "L26" });
	});

	it("still reaches a seam's holder by its plain words, its id unsaid", () => {
		const found = routeNeed(
			{ ...asked("A", ...wordsOf("the node kubelet path")), fromText: true },
			{
				foragers: cells({ A: [], S: wordsOf("node_kubelet_cri") }),
				ties: ties(["A", "S", 1]),
				hubs: [],
			},
		);

		expect(found, "the seam's holder, by node and kubelet").toMatchObject({
			fit: "S",
		});
	});
});

describe("a hub whose subject names an id", () => {
	const legHubs = {
		foragers: cells({
			A: [],
			H26: wordsOf("leg-26"),
			H27: wordsOf("leg-27"),
			H100: wordsOf("leg-100"),
			L: wordsOf("leg"),
		}),
		ties: ties(),
		hubs: [
			{ subject: "aquifer:leg-26", hub: "H26", fits: ["H26"] },
			{ subject: "aquifer:leg-27", hub: "H27", fits: ["H27"] },
			{ subject: "aquifer:leg-100", hub: "H100", fits: ["H100"] },
		],
	};

	it("takes a need naming its leg in prose, over another leg's hub", () => {
		const found = routeNeed(
			{ ...asked("A", ...wordsOf("Leg 26 is red")), fromText: true },
			legHubs,
		);

		expect(found, "leg-26's hub alone").toMatchObject({
			fit: "H26",
			path: ["H26"],
		});
	});

	it("takes a need naming its leg inside a longer id", () => {
		const found = routeNeed(
			{
				...asked("A", ...wordsOf("the leg-26-follow-up is red")),
				fromText: true,
			},
			legHubs,
		);

		expect(found, "leg-26's hub, inside the longer id").toMatchObject({
			fit: "H26",
			path: ["H26"],
		});
	});

	it("never takes a need whose number is said apart from the leg", () => {
		const found = routeNeed(
			{
				...asked("A", ...wordsOf("Leg 27 is red in 100 runs")),
				fromText: true,
			},
			legHubs,
		);

		expect(found.path, "no hub of leg-100 for a stray 100").not.toContain(
			"H100",
		);
		expect(found, "leg-27's hub, which it names").toMatchObject({ fit: "H27" });
	});

	it("never takes a need naming another leg, whose number it doesn't say", () => {
		const found = routeNeed(
			{ ...asked("A", ...wordsOf("Leg 27 is red")), fromText: true },
			legHubs,
		);

		expect(found.path, "no hub of leg-26 for leg 27").not.toContain("H26");
	});
});
