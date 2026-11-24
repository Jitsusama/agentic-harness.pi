/**
 * How far a need's owner reaches: an ended cell owns a need only where a
 * live one could have been found for it, along ties fresh enough or
 * through a hub routing would consult, and it is judged by the words its
 * asker lacks.
 */

import { describe, expect, it } from "vitest";
import { MOST_HOPS, OWNER_TIE_FLOOR } from "../../../lib/mesh/need-route.ts";
import { asked, cells, routeNeed, ties } from "./support/needs.ts";

/** Ties along a chain of cells, each as strong as the first. */
const chain = (...along: string[]) =>
	along
		.slice(1)
		.map((other, at): [string, string, number] => [along[at] ?? "", other, 1]);

describe("an ended cell's reach as a need's owner", () => {
	it("owns it when a live hub names it for a word, though no tie reaches it", () => {
		const reach = {
			foragers: cells({
				A: [],
				H: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1]),
			hubs: [{ subject: "dates", hub: "H", fits: ["J"] }],
		};

		const found = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J",
		});
		const unnamed = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J" && address !== "H",
		});

		expect(found, "H would have found J").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(unnamed, "with H gone, J is out of reach").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it(`owns it ${MOST_HOPS} ties away, and not one tie further`, () => {
		const foragers = cells({
			A: [],
			C: [],
			D: [],
			E: [],
			J: ["dates", "delivery"],
			B: ["delivery"],
		});
		const live = (address: string) => address !== "J";

		const near = routeNeed(asked("A", "dates", "delivery"), {
			foragers,
			ties: ties(["A", "B", 1], ...chain("A", "C", "D", "J")),
			hubs: [],
			live,
		});
		const far = routeNeed(asked("A", "dates", "delivery"), {
			foragers,
			ties: ties(["A", "B", 1], ...chain("A", "C", "D", "E", "J")),
			hubs: [],
			live,
		});

		expect(near).toMatchObject({ fit: null, ended: ["J"], fellShort: "B" });
		expect(far).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("owns nothing reached only through another ended cell", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				E: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["A", "E", 1], ["E", "J", 1]),
			hubs: [],
			live: (address) => address !== "J" && address !== "E",
		});

		expect(found, "routing walks through live cells alone").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("owns nothing by a tie faded past one message six hours old", () => {
		const reach = (strength: number) => ({
			foragers: cells({ A: [], J: ["dates", "delivery"], B: ["delivery"] }),
			ties: ties(["A", "B", 1], ["A", "J", strength]),
			hubs: [],
			live: (address: string) => address !== "J",
		});

		const faded = routeNeed(
			asked("A", "dates", "delivery"),
			reach(OWNER_TIE_FLOOR / 2),
		);
		const fresh = routeNeed(
			asked("A", "dates", "delivery"),
			reach(OWNER_TIE_FLOOR),
		);

		expect(faded, "a crashed record's ties fade out").toMatchObject({
			path: ["B"],
			fit: "B",
		});
		expect(fresh).toMatchObject({ fit: null, ended: ["J"], fellShort: "B" });
	});

	it("owns nothing named by a broader hub than the one routing consults", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				H1: [],
				H2: [],
				L: ["dates"],
				J: ["dates", "delivery"],
			}),
			ties: ties(),
			hubs: [
				{ subject: "lanes:dates", hub: "H1", fits: ["L"] },
				{ subject: "dates", hub: "H2", fits: ["J"] },
			],
			live: (address) => address !== "J",
		});

		expect(found, "the narrower hub names a live fit").toMatchObject({
			path: ["H1", "L"],
			fit: "L",
		});
		expect(found).not.toHaveProperty("fellShort");
	});
});

describe("what an ended owner is judged by", () => {
	it("counts only the words its asker lacks, so a sibling of the asker owns nothing", () => {
		const found = routeNeed(asked("A", "mesh", "delivery"), {
			foragers: cells({
				A: ["mesh"],
				J: ["mesh", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["A", "J", 1]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found, "B covers all A lacks").toMatchObject({
			path: ["B"],
			fit: "B",
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	it("names as fallen short the live cell in reach on most of it, not the nearest find", () => {
		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			foragers: cells({
				A: [],
				H: [],
				J: ["dates", "delivery", "slots"],
				B: ["delivery"],
				K: ["delivery", "slots"],
			}),
			ties: ties(["A", "B", 1], ["A", "J", 1]),
			hubs: [{ subject: "dates", hub: "H", fits: ["K"] }],
			live: (address) => address !== "J",
		});

		expect(found, "K shares two words, B one").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "K",
		});
	});
});

describe("a live cell taking an ended owner's need", () => {
	it("takes it through a hub that names it for a word it doesn't hold", () => {
		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			foragers: cells({
				A: [],
				H: [],
				J: ["delivery", "slots"],
				B: ["delivery"],
				K: ["delivery", "slots"],
				C: ["dates"],
			}),
			ties: ties(["A", "B", 1], ["A", "J", 1]),
			hubs: [{ subject: "dates", hub: "H", fits: ["K"] }],
			live: (address) => address !== "J",
		});

		expect(found, "C, untied, is found by nothing").toMatchObject({
			path: ["H", "K"],
			fit: "K",
			ended: ["J"],
		});
	});

	it("takes the nearest along ties of two working on as much, before a hub's", () => {
		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			foragers: cells({
				A: [],
				H: [],
				J: ["dates", "delivery"],
				C: ["dates"],
				B: ["delivery"],
				K: ["dates", "delivery"],
				M: ["dates", "delivery"],
				S: ["slots"],
			}),
			ties: ties(["A", "C", 2], ["A", "B", 2], ["A", "J", 1], ["C", "K", 1]),
			hubs: [{ subject: "slots", hub: "H", fits: ["M"] }],
			live: (address) => address !== "J",
		});

		expect(found, "K, two ties out, before M by a hub").toMatchObject({
			path: ["C", "K"],
			fit: "K",
			ended: ["J"],
		});
	});
});
