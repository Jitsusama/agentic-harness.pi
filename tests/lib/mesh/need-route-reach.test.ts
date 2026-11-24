/**
 * A need's owner: an ended cell routing would have sent it to, were it
 * alone back, working on more of what the asker lacks than the fit
 * found. Found by routing itself, so by the same hubs and walks, never
 * walked through, and only while it was heard from lately: a tie it
 * sent on today heard along within six hours.
 */

import { describe, expect, it } from "vitest";
import { MOST_HOPS, OWNER_TIE_AGE_MS } from "../../../lib/mesh/need-route.ts";
import { AT, asked, cells, routeNeed, ties } from "./support/needs.ts";

/** Ties along a chain of cells, each as strong as the first. */
const chain = (...along: string[]) =>
	along
		.slice(1)
		.map((other, at): [string, string, number] => [along[at] ?? "", other, 1]);

/** An hour, for ties heard some hours before the need. */
const HOUR = 60 * 60 * 1000;

describe("an ended cell owning a need", () => {
	it("owns it where a live hub would name it for a word it holds, and has it once back", () => {
		const reach = {
			foragers: cells({
				A: [],
				H: [],
				Z: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["J", "Z", 1]),
			hubs: [{ subject: "dates", hub: "H", fits: ["J"] }],
		};

		const found = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery"), reach);
		const unnamed = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J" && address !== "H",
		});

		expect(found, "H would have found J").toMatchObject({
			path: [],
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(back, "sent again once J is back").toMatchObject({
			path: ["H", "J"],
			fit: "J",
		});
		expect(unnamed, "with H gone, nothing finds J").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("owns nothing a hub names for a word it doesn't hold, as routing never takes it", () => {
		const reach = {
			foragers: cells({
				A: [],
				H: [],
				Z: [],
				C: ["dates"],
				B: ["delivery"],
				J: ["delivery", "slots"],
			}),
			ties: ties(["A", "B", 1], ["J", "Z", 1]),
			hubs: [{ subject: "dates", hub: "H", fits: ["J"] }],
		};

		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery", "slots"), reach);

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
		expect(found).not.toHaveProperty("fellShort");
		expect(back, "J back is still not found").toMatchObject({ fit: "B" });
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

		expect(found, "an ended cell passes nothing on").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("owns nothing six hours after its last message, however strong the tie", () => {
		const reach = (heard: number) => ({
			foragers: cells({ A: [], J: ["dates", "delivery"], B: ["delivery"] }),
			ties: ties(["A", "B", 1], ["A", "J", 200, heard]),
			hubs: [],
			live: (address: string) => address !== "J",
		});

		const lately = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT - 5 * HOUR),
		);
		const long = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT - 7 * HOUR),
		);
		const edge = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT - OWNER_TIE_AGE_MS),
		);

		expect(7 * HOUR).toBeGreaterThan(OWNER_TIE_AGE_MS);
		expect(lately).toMatchObject({ fit: null, ended: ["J"], fellShort: "B" });
		expect(edge, "six hours to the millisecond still counts").toMatchObject({
			fit: null,
			fellShort: "B",
		});
		expect(long, "a crashed record stops owning").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("owns nothing a broader hub names when a narrower one names a live cell", () => {
		const found = routeNeed(asked("A", "lanes", "dates", "delivery"), {
			foragers: cells({
				A: [],
				H1: [],
				H2: [],
				Z: [],
				E: ["dates"],
				J: ["lanes", "dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["E", "Z", 1], ["J", "Z", 1]),
			hubs: [
				{ subject: "lanes:dates", hub: "H1", fits: ["E"] },
				{ subject: "dates", hub: "H2", fits: ["J"] },
			],
			live: (address) => address !== "J",
		});

		expect(found, "routing for dates stops at H1's E").toMatchObject({
			path: ["H1", "E"],
			fit: "E",
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	it("owns it where a broader hub names it when the narrower one's cell has ended too", () => {
		const reach = {
			foragers: cells({
				A: [],
				H1: [],
				H2: [],
				Z: [],
				E: ["dates"],
				J: ["lanes", "dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["E", "Z", 1], ["J", "Z", 1]),
			hubs: [
				{ subject: "lanes:dates", hub: "H1", fits: ["E"] },
				{ subject: "dates", hub: "H2", fits: ["J"] },
			],
		};

		const found = routeNeed(asked("A", "lanes", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "E" && address !== "J",
		});
		const back = routeNeed(asked("A", "lanes", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "E",
		});

		expect(found, "E counted there would hide J").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(back, "J alone back").toMatchObject({
			path: ["H2", "J"],
			fit: "J",
		});
	});

	it("owns nothing where once back its own narrower hub would name a cell sharing less", () => {
		const reach = {
			foragers: cells({
				A: [],
				H2: [],
				O: [],
				X: ["dates"],
				J: ["lanes", "dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["J", "O", 1]),
			hubs: [
				{ subject: "lanes:dates", hub: "J", fits: ["X"] },
				{ subject: "dates", hub: "H2", fits: ["J"] },
			],
		};

		const found = routeNeed(asked("A", "lanes", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "lanes", "dates", "delivery"), {
			...reach,
			live: () => true,
		});

		expect(back, "J's own hub names X ahead of H2").toMatchObject({
			path: ["J", "X"],
			fit: "X",
		});
		expect(found, "so a resend would never reach J").toMatchObject({
			path: ["B"],
			fit: "B",
			ended: ["J"],
			unheld: ["lanes"],
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	it("owns it past a nearer ended cell working on less, tried alone", () => {
		const reach = {
			foragers: cells({
				A: [],
				C: [],
				E: ["dates"],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "E", 1], ["A", "C", 1], ["C", "J", 1], ["A", "B", 1]),
			hubs: [],
		};

		const found = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "E" && address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "E",
		});

		expect(found, "E counted there would stop the dates walk").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(back).toMatchObject({ path: ["C", "J"], fit: "J" });
	});

	it("owns it though once back it leads a resend on to a cell covering more", () => {
		const reach = {
			foragers: cells({
				A: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
				K: ["dates", "delivery", "slots"],
			}),
			ties: ties(["A", "J", 1], ["A", "B", 1], ["J", "K", 1]),
			hubs: [],
		};

		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery", "slots"), reach);

		expect(found, "K sits behind J").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(back, "walked through J once back").toMatchObject({
			path: ["J", "K"],
			fit: "K",
		});
	});

	it("owns nothing by a tie only others sent on, as askers after a crashed cell do", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({ A: [], J: ["dates", "delivery"], B: ["delivery"] }),
			ties: ties(["A", "B", 1], ["A", "J", 9, AT, [true, false]]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
		expect(found).not.toHaveProperty("fellShort");
	});

	it("owns nothing when the tie it sent on is old and only another's is fresh", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				O: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(
				["A", "B", 1],
				["J", "O", 1, AT - 20 * HOUR],
				["A", "J", 1, AT, [true, false]],
			),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found, "spoken on and fresh must be one tie").toMatchObject({
			path: ["B"],
			fit: "B",
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	it("owns nothing by a tie heard more than six hours ahead, or at no time a number weighs", () => {
		const reach = (heard: number) => ({
			foragers: cells({ A: [], J: ["dates", "delivery"], B: ["delivery"] }),
			ties: ties(["A", "B", 1], ["A", "J", 1, heard]),
			hubs: [],
			live: (address: string) => address !== "J",
		});

		const ahead = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT + 7 * HOUR),
		);
		const endless = routeNeed(
			asked("A", "dates", "delivery"),
			reach(Number.POSITIVE_INFINITY),
		);
		const stepped = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT + HOUR),
		);
		const unweighed = routeNeed(
			asked("A", "dates", "delivery"),
			reach(Number.NaN),
		);

		expect(ahead).toMatchObject({ path: ["B"], fit: "B" });
		expect(endless).toMatchObject({ path: ["B"], fit: "B" });
		expect(unweighed).toMatchObject({ path: ["B"], fit: "B" });
		expect(stepped, "a clock stepped back an hour").toMatchObject({
			fit: null,
			ended: ["J"],
		});
	});

	it("names the fit found as fallen short, and the owner has it once back", () => {
		const reach = {
			foragers: cells({
				A: [],
				J: ["dates", "delivery", "slots"],
				B: ["delivery"],
				S: ["slots"],
				K: ["delivery", "slots"],
			}),
			ties: ties(["A", "J", 1], ["A", "B", 1], ["A", "S", 1], ["B", "K", 1]),
			hubs: [],
		};

		const found = routeNeed(asked("A", "dates", "delivery", "slots"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery", "slots"), reach);

		expect(found, "K, behind B, is found by nothing").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
		expect(back).toMatchObject({ path: ["J"], fit: "J" });
	});

	it("owns nothing routing would pass over for a nearer cell, ended or back", () => {
		const reach = {
			foragers: cells({
				A: [],
				C: ["dates"],
				B: ["delivery"],
				J: ["dates", "delivery"],
			}),
			ties: ties(["A", "C", 2], ["A", "B", 2], ["C", "J", 1]),
			hubs: [],
		};

		const found = routeNeed(asked("A", "dates", "delivery"), {
			...reach,
			live: (address) => address !== "J",
		});
		const back = routeNeed(asked("A", "dates", "delivery"), reach);

		expect(found, "each word's walk stops a hop short of J").toMatchObject({
			path: ["C"],
			fit: "C",
		});
		expect(back).toMatchObject({ path: ["C"], fit: "C" });
	});
});

describe("what a fit and an owner are weighed by", () => {
	it("takes the fit covering more of what the asker lacks over one sharing its own work", () => {
		const reach = {
			foragers: cells({
				A: ["mesh", "workflow"],
				X: ["mesh", "workflow", "delivery"],
				Y: ["delivery", "slots"],
				O: ["delivery", "slots"],
			}),
			ties: ties(["A", "X", 1], ["A", "Y", 1], ["A", "O", 1]),
			hubs: [],
		};

		const found = routeNeed(
			asked("A", "mesh", "workflow", "delivery", "slots"),
			{ ...reach, live: (address) => address !== "O" },
		);

		expect(found, "Y covers both words A lacks").toMatchObject({
			path: ["Y"],
			fit: "Y",
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	it("names an ended cell heard from lately for a word no live cell works on", () => {
		const reach = (heard: number) => ({
			foragers: cells({ A: [], J: ["dates"], B: ["delivery"] }),
			ties: ties(["A", "B", 1], ["A", "J", 1, heard]),
			hubs: [],
			live: (address: string) => address !== "J",
		});

		const lately = routeNeed(asked("A", "dates", "delivery"), reach(AT));
		const long = routeNeed(
			asked("A", "dates", "delivery"),
			reach(AT - 7 * HOUR),
		);

		expect(lately, "J's dates would go unsaid").toMatchObject({
			path: ["B"],
			fit: "B",
			ended: ["J"],
		});
		expect(long, "dates is still said, J unnamed").toMatchObject({
			path: ["B"],
			fit: "B",
			unheld: ["dates"],
		});
		expect(long).not.toHaveProperty("ended");
	});

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
});
