/**
 * A need found by the subjects cells declare: a hub chosen by how narrow
 * its subject is rather than how long. The words each subject gives a
 * cell are need-route-subject-words.test.ts's.
 */

import { describe, expect, it } from "vitest";
import {
	foragersFrom,
	type Hub,
	LONGEST_WORD,
	MOST_WORDS,
	type NeedAsked,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
import {
	asked,
	cells,
	numbered,
	routeNeed,
	SHARED_NEEDS,
	ties,
} from "./support/needs.ts";

/**
 * The fits `equalHubs` draws for `A/0` to `A/3`, as sha256 orders them
 * in bytes; a change here means needs reach other hubs than before.
 */
const DRAWN = ["F3", "F0", "F1", "F1"];

/**
 * Four hubs that rank the same for `carry`, each naming its own fit
 * working on it, with the subject and the hub cell each hub has.
 */
const equalHubs = (
	subject: (at: number) => string,
	hub: (at: number) => string,
) => {
	const hubs: Hub[] = Array.from({ length: 4 }, (_, at) => ({
		subject: subject(at),
		hub: hub(at),
		fits: [`F${at}`],
	}));
	const foragers = cells({
		A: [],
		...Object.fromEntries(hubs.map((_, at) => [`F${at}`, ["carry"]])),
	});
	return { hubs, foragers, ties: ties() };
};

/** How many of `needs` each fit took over `reach`. */
const takenOver = (
	needs: readonly NeedAsked[],
	reach: Parameters<typeof routeNeed>[1],
): Map<string | null, number> => {
	const taken = new Map<string | null, number>();
	for (const need of needs) {
		const { fit } = routeNeed(need, reach);
		taken.set(fit, (taken.get(fit) ?? 0) + 1);
	}
	return taken;
};

describe("a need routed by declared subjects", () => {
	it("reaches the cell declaring its subject past a nearer one holding a generic word", () => {
		// The first live need: `lines` was in other cells' titles, and no
		// title said easing. X makes lines the commoner word, so easing
		// leads by rarity rather than by sorting first.
		const found = routeNeed(asked("A", "mycelium", "easing", "lines"), {
			foragers: [
				...cells({
					A: ["web", "funnel"],
					W: ["command", "lines"],
					X: ["lines"],
				}),
				...foragersFrom(
					JSON.stringify({
						id: 2,
						records: [
							{
								key: "cell:BBBBBB",
								title: "Carry a Session",
								repo: "mycelium",
								subjects: ["mycelium:easing"],
							},
							{ key: "cell:MMMMMM", title: "Mycelium Map" },
						],
					}),
				),
			],
			ties: ties(["A", "W", 9], ["A", "MMMMMM", 5], ["W", "BBBBBB", 1]),
			hubs: [],
		});

		expect(found, "easing, the rarest word, carries it to B").toMatchObject({
			fit: "BBBBBB",
			path: ["W", "BBBBBB"],
		});
	});

	it("keeps the rarest words when a need says more than MOST_WORDS held ones", () => {
		const common = Array.from({ length: MOST_WORDS }, (_, at) => `word${at}`);
		const found = routeNeed(asked("A", ...common, "rare"), {
			foragers: cells({ A: [], B: common, C: [...common, "rare"] }),
			ties: ties(["A", "B", 2], ["A", "C", 1]),
			hubs: [],
		});

		expect(
			found.words,
			"the rarest is kept, then the first said among as rare, in the order said",
		).toEqual([...common.slice(0, MOST_WORDS - 1), "rare"]);
		expect(found.fit).toBe("C");
	});

	it("keeps a word another cell would take over the asker's own rarer ones", () => {
		const own = Array.from({ length: MOST_WORDS }, (_, at) => `mine${at}`);
		const found = routeNeed(asked("A", ...own, "easing"), {
			foragers: cells({ A: own, B: ["easing"], C: ["easing"] }),
			ties: ties(["A", "B", 2], ["A", "C", 1]),
			hubs: [],
		});

		expect(found.words, "easing routes it, so it is kept").toContain("easing");
		expect(found, "never taken as the asker's own").toMatchObject({
			fit: "B",
			path: ["B"],
		});
	});

	it("puts a need to the hub of a subject whose narrowest part breaks at a hyphen", () => {
		for (const need of numbered("A", "host")) {
			const found = routeNeed(need, {
				foragers: cells({ A: [], H: ["host"], F: ["host"] }),
				ties: ties(),
				hubs: [
					{ subject: "pi-host", hub: "H", fits: ["H"] },
					{ subject: "unit:pi-host-", hub: "H", fits: ["F"] },
				],
			});

			expect(found, "the deeper subject, the narrower, wins").toMatchObject({
				fit: "F",
				path: ["H", "F"],
			});
		}
	});

	it("ranks hubs by depth, never by the length of their subject", () => {
		for (const need of numbered("A", "easing")) {
			const found = routeNeed(need, {
				foragers: cells({ A: [], S: ["easing"], D: ["easing"] }),
				ties: ties(),
				hubs: [
					{ subject: "observability-padded:easing", hub: "S", fits: ["S"] },
					{ subject: "a:b:easing", hub: "D", fits: ["D"] },
				],
			});

			expect(found, "three parts beat two, however long").toMatchObject({
				fit: "D",
			});
		}
	});

	it("puts a need to the hub saying most of what it says, before a deeper one saying less", () => {
		// X and Y make lines commoner, so easing is tried first, and both
		// hubs say easing.
		for (const need of numbered("A", "easing", "lines")) {
			const found = routeNeed(need, {
				foragers: cells({
					A: [],
					D: ["easing"],
					B: ["easing", "lines"],
					X: ["lines"],
					Y: ["lines"],
				}),
				ties: ties(),
				hubs: [
					{ subject: "a:b:easing", hub: "D", fits: ["D"] },
					{ subject: "x:easing-lines", hub: "B", fits: ["B"] },
				],
			});

			expect(
				found,
				"easing-lines says both, so it is the narrower",
			).toMatchObject({
				fit: "B",
			});
		}
	});

	it("matches a hub on what the need said, not only on the words it kept", () => {
		// Eleven words as rare as easing fill the twelve with it, crowding
		// out lines, which two cells hold; the need still said lines, so
		// easing-lines is its hub.
		const rare = Array.from({ length: MOST_WORDS - 1 }, (_, at) => `rare${at}`);
		const found = routeNeed(asked("A", "easing", "lines", ...rare), {
			foragers: cells({
				A: [],
				B: ["easing", "lines"],
				W: ["lines"],
				...Object.fromEntries(rare.map((word) => [`R${word}`, [word]])),
			}),
			ties: ties(),
			hubs: [{ subject: "x:easing-lines", hub: "B", fits: ["B"] }],
		});

		expect(found.words, "lines is past the cap").not.toContain("lines");
		expect(found, "easing-lines is still its hub").toMatchObject({
			fit: "B",
			path: ["B"],
		});
	});

	it("shares hubs as deep and as telling out among needs, never shortest first", () => {
		const hubs = [
			{ subject: "observability-padded:easing", hub: "S", fits: ["S"] },
			{ subject: "zz:easing", hub: "D", fits: ["D"] },
		];
		const reach = {
			foragers: cells({ A: [], S: ["easing"], D: ["easing"] }),
			ties: ties(),
		};
		const taken = takenOver(numbered("A", "easing"), { ...reach, hubs });

		expect([...taken.keys()].sort(), "each takes some, the longer too").toEqual(
			["D", "S"],
		);
	});

	it("puts one need id to the same hub among equals, whatever order they are listed in", () => {
		const reach = equalHubs(
			(at) => `realm.g${at}:carry`,
			(at) => `H${at}`,
		);

		for (const need of numbered("A", "carry")) {
			expect(routeNeed(need, reach).fit).toBe(
				routeNeed(need, { ...reach, hubs: [...reach.hubs].reverse() }).fit,
			);
		}
	});

	it("shares one subject's needs out over its hubs, each its own cell", () => {
		// A node names a hub for each ten holders of a subject, all under
		// the one subject; listing them in one order must not send every
		// need to the first.
		const taken = takenOver(
			numbered("A", "carry"),
			equalHubs(
				() => "realm:carry",
				(at) => `H${at}`,
			),
		);

		expect([...taken.keys()].sort()).toEqual(["F0", "F1", "F2", "F3"]);
		expect(
			Math.max(...taken.values()),
			"none takes more than half",
		).toBeLessThanOrEqual(SHARED_NEEDS / 2);
	});

	it("shares needs out over equal subjects that one cell hubs", () => {
		const taken = takenOver(
			numbered("A", "carry"),
			equalHubs(
				(at) => `realm.g${at}:carry`,
				() => "H",
			),
		);

		expect([...taken.keys()].sort()).toEqual(["F0", "F1", "F2", "F3"]);
	});

	it("puts a need to the next equal hub when the one it drew is gone", () => {
		const reach = equalHubs(
			(at) => `realm.g${at}:carry`,
			(at) => `H${at}`,
		);
		const taken = takenOver(numbered("A", "carry"), {
			...reach,
			live: (address) => !["H0", "H1", "H2"].includes(address),
		});

		expect([...taken.entries()]).toEqual([["F3", SHARED_NEEDS]]);
	});

	it.each([
		["a gone hub", "H0"],
		["a hub whose fit is gone", "F0"],
	])(
		"puts only the needs that drew %s elsewhere, shared over the rest",
		(_, away) => {
			const reach = equalHubs(
				(at) => `realm.g${at}:carry`,
				(at) => `H${at}`,
			);
			const gone = { ...reach, live: (address: string) => address !== away };
			const moved = new Set<string | null>();

			for (const need of numbered("A", "carry")) {
				const drawn = routeNeed(need, reach).fit;
				const now = routeNeed(need, gone).fit;
				if (drawn === "F0") moved.add(now);
				else expect(now, need.need).toBe(drawn);
			}

			expect(
				[...moved].filter((fit) => !["F1", "F2", "F3"].includes(fit ?? "")),
				"each to another hub's fit",
			).toEqual([]);
			expect(moved.size, "not all to the first listed").toBeGreaterThan(1);
		},
	);

	it("puts a need to the next equal hub when the one it drew has no live fit", () => {
		const reach = equalHubs(
			(at) => `realm.g${at}:carry`,
			(at) => `H${at}`,
		);
		const taken = takenOver(numbered("A", "carry"), {
			...reach,
			live: (address) => !["F0", "F1", "F2"].includes(address),
		});

		expect([...taken.entries()]).toEqual([["F3", SHARED_NEEDS]]);
	});

	it("draws the same hub for a known need id on every machine", () => {
		const reach = equalHubs(
			(at) => `realm.g${at}:carry`,
			(at) => `H${at}`,
		);

		expect(
			numbered("A", "carry")
				.slice(0, 4)
				.map((need) => routeNeed(need, reach).fit),
			"a sha256 in byte order, the same anywhere",
		).toEqual(DRAWN);
	});

	it("names every ended fit among the equal hubs it weighed", () => {
		const reach = equalHubs(
			(at) => `realm.g${at}:carry`,
			(at) => `H${at}`,
		);
		const live = (address: string) => address !== "F0";

		for (const need of numbered("A", "carry")) {
			expect(routeNeed(need, { ...reach, live }).ended).toEqual(["F0"]);
		}
	});

	it("never takes a lower-ranked hub's fuller fit over the top rank's", () => {
		// E1 to E3 make easing commoner, so carry is tried first; the
		// deeper hub outranks the shallow one, though F1 works on more.
		const taken = takenOver(numbered("A", "carry", "easing"), {
			foragers: cells({
				A: [],
				F0: ["carry"],
				F1: ["carry", "easing"],
				E1: ["easing"],
				E2: ["easing"],
				E3: ["easing"],
			}),
			ties: ties(),
			hubs: [
				{ subject: "carry", hub: "H1", fits: ["F1"] },
				{ subject: "realm:carry", hub: "H0", fits: ["F0"] },
			],
		});

		expect([...taken.entries()]).toEqual([["F0", SHARED_NEEDS]]);
	});

	it("puts a need to a lower-ranked hub, before the walk, when the top rank has no live fit", () => {
		const taken = takenOver(numbered("A", "carry"), {
			foragers: cells({ A: [], F0: ["carry"], F1: ["carry"], W: ["carry"] }),
			ties: ties(["A", "W", 9]),
			hubs: [
				{ subject: "realm:carry", hub: "H0", fits: ["F0"] },
				{ subject: "carry", hub: "H1", fits: ["F1"] },
			],
			live: (address) => address !== "F0",
		});

		expect([...taken.entries()]).toEqual([["F1", SHARED_NEEDS]]);
	});

	it("weighs the whole next rank when the top has no live fit, and goes no lower", () => {
		// Only carry has hubs. The top rank's fit is gone; of the next
		// rank's two, F1 works on more of the need, and the rank below
		// holds F2, which works on all of it.
		const reach = {
			foragers: cells({
				A: [],
				X: ["carry"],
				F0: ["carry"],
				F1: ["carry", "easing"],
				F2: ["carry", "easing", "lines"],
			}),
			ties: ties(),
			hubs: [
				{ subject: "realm.g9.top:carry", hub: "H9", fits: ["X"] },
				{ subject: "realm.g0:carry", hub: "H0", fits: ["F0"] },
				{ subject: "realm.g1:carry", hub: "H1", fits: ["F1"] },
				{ subject: "realm:carry", hub: "H2", fits: ["F2"] },
			],
			live: (address: string) => address !== "X",
		};
		const needs = numbered("A", "carry", "easing", "lines");

		expect(
			[
				...new Set(
					needs.map((need) => routeNeed(need, reach).path.join(" > ")),
				),
			],
			"each by H1 to its own fit",
		).toEqual(["H1 > F1"]);
	});

	it("puts a need to the equal hub whose fit works on most of it, whatever it drew", () => {
		// E1 to E3 make easing commoner, so carry is tried first, and both
		// hubs rank the same for it; only F1 works on easing too.
		const taken = takenOver(numbered("A", "carry", "easing"), {
			foragers: cells({
				A: [],
				F0: ["carry"],
				F1: ["carry", "easing"],
				E1: ["easing"],
				E2: ["easing"],
				E3: ["easing"],
			}),
			ties: ties(),
			hubs: [
				{ subject: "realm.g0:carry", hub: "H0", fits: ["F0"] },
				{ subject: "realm.g1:carry", hub: "H1", fits: ["F1"] },
			],
		});

		expect([...taken.entries()]).toEqual([["F1", SHARED_NEEDS]]);
	});

	it("takes no hub whose subject says words the need doesn't, before walking for a rarer word", () => {
		// H's hub says lines among other words; the need says lines but
		// not pallet, so that hub isn't the need's, and easing, rarer,
		// is walked for instead.
		const found = routeNeed(asked("A", "easing", "lines"), {
			foragers: cells({
				A: [],
				C: ["easing"],
				H: ["pallet", "lines"],
				W: ["lines"],
			}),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: "x:pallet-lines", hub: "H", fits: ["H"] }],
		});

		expect(found, "easing carries it to C").toMatchObject({
			fit: "C",
			path: ["C"],
		});
	});

	// No need keeps a word past LONGEST_WORD, so a subject saying one is
	// never said whole, and its hub can't take a need saying only its
	// short part (#2220's third judge).
	it("takes no hub whose subject says a word longer than any a need keeps", () => {
		const long = "p".repeat(LONGEST_WORD + 1);
		const found = routeNeed(asked("A", "easing", "lines"), {
			foragers: cells({
				A: [],
				C: ["easing"],
				H: ["lines"],
				W: ["lines"],
			}),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: `x:${long}-lines`, hub: "H", fits: ["H"] }],
		});

		expect(found, "easing carries it to C").toMatchObject({
			fit: "C",
			path: ["C"],
		});
	});

	// A word past LONGEST_WORD is a token, not work, even said whole, so
	// the hub config refuses is never taken (#2220's fifth council, F1
	// and F5).
	it("takes no hub for a word longer than any a need keeps, even said whole", () => {
		const long = "p".repeat(LONGEST_WORD + 1);
		const found = routeNeed(asked("A", "easing", long, "lines"), {
			foragers: cells({
				A: [],
				C: ["easing"],
				H: ["lines"],
				W: ["lines"],
			}),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: `x:${long}-lines`, hub: "H", fits: ["H"] }],
		});

		expect(found, "easing carries it to C").toMatchObject({
			fit: "C",
			path: ["C"],
		});
	});

	// The cap keeps a word as long as it, so a hub of one is taken by a
	// need saying it (#2220's sixth council, F44).
	it("takes the hub for a word as long as LONGEST_WORD, said whole", () => {
		const longest = "p".repeat(LONGEST_WORD);
		const found = routeNeed(asked("A", "easing", longest, "lines"), {
			foragers: cells({
				A: [],
				C: ["easing"],
				H: ["lines"],
				W: ["lines"],
			}),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: `x:${longest}-lines`, hub: "H", fits: ["H"] }],
		});

		expect(found, "its hub takes it to H").toMatchObject({
			fit: "H",
			path: ["H"],
		});
	});

	// A joined id with a number is said only whole or inside a longer id,
	// and past LONGEST_WORD no need keeps it: a hub left matching by its
	// other words would take a need for leg 27 for a subject of leg 26
	// (#2220's sixth council, F57).
	it("takes no hub whose subject joins a number into an id longer than any a need keeps", () => {
		const word = "p".repeat(LONGEST_WORD - 6);
		const found = routeNeed(asked("A", ...wordsOf(`easing ${word} leg 27`)), {
			foragers: cells({
				A: [],
				C: ["easing"],
				H: ["leg"],
				W: ["leg"],
			}),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: `x:${word}-leg-26`, hub: "H", fits: ["H"] }],
		});

		expect(found, "easing carries it to C").toMatchObject({
			fit: "C",
			path: ["C"],
		});
	});

	it("keeps a word only an ended cell holds by how rare it is, going to the live cell holding more", () => {
		const taken = Array.from({ length: MOST_WORDS }, (_, at) => `word${at}`);
		const found = routeNeed(asked("A", "gone", ...taken), {
			foragers: cells({ A: [], B: taken, C: taken, E: ["gone"] }),
			ties: ties(["A", "B", 1], ["A", "E", 2]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found.words, "one cell held gone, two each other word").toEqual([
			"gone",
			...taken.slice(0, MOST_WORDS - 1),
		]);
		expect(found, "B works on more of it than E did").toMatchObject({
			fit: "B",
			path: ["B"],
		});
	});

	// Kept rarest first, gone stays though past MOST_WORDS, so the owner
	// check sees E hold every kept word where B holds all but one.
	it("sees an ended owner past the most words a need keeps", () => {
		const taken = Array.from({ length: MOST_WORDS }, (_, at) => `word${at}`);
		const found = routeNeed(asked("A", "gone", ...taken), {
			foragers: cells({
				A: [],
				B: taken,
				C: taken,
				D: taken.slice(-1),
				E: ["gone", ...taken.slice(0, -1)],
			}),
			ties: ties(["A", "B", 1], ["A", "E", 2]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found.words, "gone, then the first taken").toEqual([
			"gone",
			...taken.slice(0, -1),
		]);
		expect(found, "E worked on every kept word").toMatchObject({
			fit: null,
			ended: ["E"],
			fellShort: "B",
		});
	});

	it("never takes a live cell that stopped the asker, naming it as that", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], S: ["carry"] }),
			ties: ties(["A", "S", 1]),
			hubs: [{ subject: "mycelium:carry", hub: "S", fits: ["S"] }],
			live: () => true,
			stopped: (address) => address === "S",
		});

		expect(found, "lost, naming S as the one that stopped it").toMatchObject({
			fit: null,
			stopped: ["S"],
		});
	});

	// A need goes to its fit alone, so a cell it was found through never
	// hears it, and one that stopped the asker may still be found through.
	it("finds a fit through a hub cell that stopped the asker, which never hears it", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], S: ["carry"], F: ["carry"] }),
			ties: ties(),
			hubs: [{ subject: "mycelium:carry", hub: "S", fits: ["S", "F"] }],
			live: () => true,
			stopped: (address) => address === "S",
		});

		expect(found, "F takes it by S's hub, S never").toMatchObject({
			fit: "F",
			path: ["S", "F"],
		});
		expect(found.stopped, "found, so nobody is named").toBeUndefined();
	});

	it("walks through a cell that stopped the asker, never taking it", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], S: ["carry"], F: ["carry"] }),
			ties: ties(["A", "S", 1], ["S", "F", 1]),
			hubs: [],
			live: () => true,
			stopped: (address) => address === "S",
		});

		expect(found, "F, one tie past S").toMatchObject({
			fit: "F",
			path: ["S", "F"],
		});
	});

	it("puts no asker at the head of a path when it is the hub", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], F: ["carry"] }),
			ties: ties(),
			hubs: [{ subject: "mycelium:carry", hub: "A", fits: ["F"] }],
		});

		expect(found, "straight to F").toMatchObject({ fit: "F", path: ["F"] });
	});

	it("names no fit of a gone hub as passed over", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], E: ["carry"], C: ["carry"] }),
			ties: ties(["A", "C", 1]),
			hubs: [{ subject: "mycelium:carry", hub: "H", fits: ["E"] }],
			live: (address) => address !== "H" && address !== "E",
		});

		expect(found, "C along the tie").toMatchObject({ fit: "C", path: ["C"] });
		expect(
			found.ended,
			"H is gone, so its fits were never read",
		).toBeUndefined();
	});

	it("keeps a word only a cell that stopped the asker holds over the asker's own", () => {
		// S is gone as well, which is never said of a cell that stopped the
		// asker: it is named as that alone.
		const own = Array.from({ length: MOST_WORDS }, (_, at) => `mine${at}`);
		const found = routeNeed(asked("A", ...own, "carry"), {
			foragers: cells({ A: own, S: ["carry"] }),
			ties: ties(["A", "S", 1]),
			hubs: [],
			live: (address) => address !== "S",
			stopped: (address) => address === "S",
		});

		expect(
			found.ended,
			"S stopped it, so it is never named ended",
		).toBeUndefined();

		expect(found.words, "the stopper's word is kept").toContain("carry");
		expect(found, "lost, naming S, not the asker's own").toMatchObject({
			fit: null,
			stopped: ["S"],
		});
	});

	it("keeps a word only another cell holds over words the asker holds too, which route nowhere", () => {
		const shared = Array.from({ length: MOST_WORDS }, (_, at) => `both${at}`);
		const found = routeNeed(asked("A", ...shared, "carry"), {
			foragers: cells({ A: shared, B: shared, C: ["carry"] }),
			ties: ties(["A", "C", 1]),
			hubs: [],
		});

		expect(found.words, "carry is kept").toContain("carry");
		expect(found, "C takes it, not the asker").toMatchObject({
			fit: "C",
		});
	});

	it("keeps a word only an ended cell holds over the asker's own, so the need reads as lost", () => {
		const own = Array.from({ length: MOST_WORDS }, (_, at) => `mine${at}`);
		const found = routeNeed(asked("A", ...own, "gone"), {
			foragers: cells({ A: own, E: ["gone"] }),
			ties: ties(["A", "E", 1]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found.words, "the ended cell's word is kept").toContain("gone");
		expect(
			found,
			"lost, naming the ended cell, not the asker's own",
		).toMatchObject({
			fit: null,
			ended: ["E"],
		});
	});
});
