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

	it("puts a need to the hub saying only its word before one saying more", () => {
		const found = routeNeed(asked("A", "lines"), {
			foragers: cells({ A: [], W: ["lines"], B: ["easing", "lines"] }),
			ties: ties(),
			hubs: [
				{ subject: "mycelium:easing-lines", hub: "B", fits: ["B"] },
				{ subject: "lines", hub: "W", fits: ["W"] },
			],
		});

		expect(found, "lines alone is the exact hub").toMatchObject({ fit: "W" });
	});

	it("ranks hubs as deep in the order the node listed them, never shortest first", () => {
		const found = routeNeed(asked("A", "easing"), {
			foragers: cells({ A: [], S: ["easing"], D: ["easing"] }),
			ties: ties(),
			hubs: [
				{ subject: "observability-padded:easing", hub: "S", fits: ["S"] },
				{ subject: "zz:easing", hub: "D", fits: ["D"] },
			],
		});

		expect(found, "the first listed, though longer").toMatchObject({
			fit: "S",
		});
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
