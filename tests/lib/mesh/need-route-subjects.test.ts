/**
 * A need found by the subjects cells declare: each subject read by its
 * narrowest part, capped so no cell can stuff its record, and a hub
 * chosen by how narrow its subject is rather than how long.
 */

import { describe, expect, it } from "vitest";
import {
	foragersFrom,
	MOST_SUBJECT_WORDS,
	MOST_SUBJECTS,
	MOST_WORDS,
	subjectWords,
} from "../../../lib/mesh/need-route.ts";
import { asked, cells, routeNeed, ties } from "./support/needs.ts";

/** How many needs, each its own id, a sharing out is judged over. */
const SHARED_NEEDS = 40;

describe("the words a cell's declared subjects give it", () => {
	it("reads the narrowest part of each subject a cell declares, beside its title", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:5HJZ8Z",
					title: "Carry a Session",
					subjects: ["mycelium:easing", "health.asks.", 12345],
				},
				{ key: "cell:9T2BBY", title: "Placement", subjects: "easing" },
			],
		});

		expect(foragersFrom(line)).toEqual([
			{ address: "5HJZ8Z", words: ["carry", "session", "easing", "asks"] },
			{ address: "9T2BBY", words: ["placement"] },
		]);
	});

	it("never gives a cell the broader words of a subject it narrows", () => {
		expect(subjectWords("mycelium:easing")).toEqual(["easing"]);
		expect(subjectWords("unit:pi-host-")).toEqual(["host"]);
		expect(subjectWords("health.asks.")).toEqual(["asks"]);
		expect(subjectWords("")).toEqual([]);
	});

	it("breaks a subject at a slash, as a repository's scope does", () => {
		expect(subjectWords("github:Jitsusama/mycelium")).toEqual(["mycelium"]);
	});

	it("reads at most MOST_SUBJECTS subjects from one cell", () => {
		// Every subject within the cap says the same word, so only the cap
		// on subjects, not the one on their words, leaves the last unread.
		const subjects = [
			...Array.from({ length: MOST_SUBJECTS }, (_, at) => `same${at}:easing`),
			"past:carry",
		];
		const line = JSON.stringify({
			id: 2,
			records: [{ key: "cell:X", subjects }],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words, "the subject past the cap is not read").toEqual([
			"easing",
		]);
	});

	it("reads every one of MOST_SUBJECTS subjects, each its own word", () => {
		const subjects = Array.from(
			{ length: MOST_SUBJECTS },
			(_, at) => `x:word${at}`,
		);
		const line = JSON.stringify({
			id: 2,
			records: [{ key: "cell:X", subjects: [5, ...subjects] }],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words, "a non-string takes no subject's place").toEqual(
			Array.from({ length: MOST_SUBJECTS }, (_, at) => `word${at}`),
		);
	});

	it("gives a word a subject shares with the title once, as the title's", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:X",
					title: "Carry a Session",
					subjects: ["mycelium:carry", "mycelium:easing"],
				},
			],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words).toEqual(["carry", "session", "easing"]);
	});

	it("gives a cell at most MOST_SUBJECT_WORDS words from all its subjects together", () => {
		const half = MOST_SUBJECT_WORDS / 2 + 1;
		const subject = (from: number) =>
			`x:${Array.from({ length: half }, (_, at) => `word${from + at}`).join("-")}`;
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:X",
					title: "Placement",
					subjects: [subject(0), subject(half)],
				},
			],
		});

		const [cell] = foragersFrom(line);

		expect(
			cell?.words,
			"its title, then the first subject words up to the cap, across subjects",
		).toEqual([
			"placement",
			...Array.from({ length: MOST_SUBJECT_WORDS }, (_, at) => `word${at}`),
		]);
	});
});

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
								key: "cell:B",
								title: "Carry a Session",
								repo: "mycelium",
								subjects: ["mycelium:easing"],
							},
							{ key: "cell:M", title: "Mycelium Map" },
						],
					}),
				),
			],
			ties: ties(["A", "W", 9], ["A", "M", 5], ["W", "B", 1]),
			hubs: [],
		});

		expect(found, "easing, the rarest word, carries it to B").toMatchObject({
			fit: "B",
			path: ["W", "B"],
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
		const found = routeNeed(asked("A", "host"), {
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
	});

	it("ranks hubs by depth, never by the length of their subject", () => {
		const found = routeNeed(asked("A", "easing"), {
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
	});

	it("puts a need to the hub saying most of what it says, before a deeper one saying less", () => {
		// X and Y make lines commoner, so easing is tried first, and both
		// hubs say easing.
		const found = routeNeed(asked("A", "easing", "lines"), {
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
		const fits = new Set(
			Array.from(
				{ length: SHARED_NEEDS },
				(_, at) =>
					routeNeed(
						{ ...asked("A", "easing"), need: `A/${at}` },
						{ ...reach, hubs },
					).fit,
			),
		);

		expect([...fits].sort(), "each takes some, the longer too").toEqual([
			"D",
			"S",
		]);
	});

	it("puts one need to the same hub among equals, whatever order they are listed in", () => {
		const hubs = Array.from({ length: 4 }, (_, at) => ({
			subject: `realm.g${at}:carry`,
			hub: `H${at}`,
			fits: [`F${at}`],
		}));
		const reach = {
			foragers: cells({
				A: [],
				...Object.fromEntries(hubs.map(({ fits }) => [fits[0], ["carry"]])),
			}),
			ties: ties(),
		};

		for (let at = 0; at < SHARED_NEEDS; at++) {
			const need = { ...asked("A", "carry"), need: `A/${at}` };
			expect(routeNeed(need, { ...reach, hubs }).fit).toBe(
				routeNeed(need, { ...reach, hubs: [...hubs].reverse() }).fit,
			);
		}
	});

	it("shares a subject's needs out over all of its hubs that rank the same", () => {
		// A node names a hub for each ten holders of a subject; listing
		// them in one order must not send every need to the first.
		const hubs = Array.from({ length: 4 }, (_, at) => ({
			subject: `realm.g${at}:carry`,
			hub: `H${at}`,
			fits: [`F${at}`],
		}));
		const taken = new Map<string, number>();
		for (let at = 0; at < SHARED_NEEDS; at++) {
			const { fit } = routeNeed(
				{ ...asked("A", "carry"), need: `A/${at}` },
				{
					foragers: cells({
						A: [],
						...Object.fromEntries(hubs.map(({ fits }) => [fits[0], ["carry"]])),
					}),
					ties: ties(),
					hubs,
				},
			);
			if (fit !== null) taken.set(fit, (taken.get(fit) ?? 0) + 1);
		}

		expect([...taken.keys()].sort()).toEqual(["F0", "F1", "F2", "F3"]);
		expect(
			Math.max(...taken.values()),
			"none takes more than half",
		).toBeLessThanOrEqual(SHARED_NEEDS / 2);
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

	it("keeps the words live cells would take over one only an ended cell holds", () => {
		const taken = Array.from({ length: MOST_WORDS }, (_, at) => `word${at}`);
		const found = routeNeed(asked("A", "gone", ...taken), {
			foragers: cells({ A: [], B: taken, E: ["gone"] }),
			ties: ties(["A", "B", 1], ["A", "E", 2]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found.words, "the ended cell's word is dropped first").toEqual(
			taken,
		);
		expect(found.fit).toBe("B");
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
