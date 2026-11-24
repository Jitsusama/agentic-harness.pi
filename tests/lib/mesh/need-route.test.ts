/**
 * A need put to what it is about: to the subject's hub where there is
 * one, else along the node's ties, each hop kept as one line the scale
 * run's judge reads.
 *
 * Long because it tests one module, need-route.ts, itself past 800
 * lines: its cases split along with it, by what each part does, rather
 * than ahead of it, and each shares the scratch root and the servers
 * set up and closed here.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	foragersFrom,
	type Hub,
	hubsFrom,
	keepNeed,
	keepNeedOnce,
	MOST_HOPS,
	MOST_WORDS,
	NEED_AGAIN_MS,
	needAt,
	needId,
	needsFile,
	tieGraphFrom,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
import { AT, asked, cells, routeNeed, ties } from "./support/needs.ts";

let root: string;
let servers: Server[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-need-"));
	servers = [];
});

afterEach(async () => {
	await Promise.all(
		servers.map((server) => new Promise((done) => server.close(done))),
	);
	rmSync(root, { recursive: true, force: true });
});

describe("the words a need or a cell's work is matched by", () => {
	it("keeps the telling words, lowercased, once each", () => {
		expect(
			wordsOf("Run a Command on Any Machine of the Realm, the realm"),
		).toEqual(["run", "command", "machine", "realm"]);
	});

	it("reads each cell's words from its title and repository", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "cell:04TNWT",
					title: "Run a Command on Any Machine",
					repo: "mycelium",
				},
				{ key: "cell:FZ9MFJ", title: "A Web, Not a Funnel" },
				{ key: "tie:A~B" },
			],
		});

		expect(foragersFrom(line)).toEqual([
			{ address: "04TNWT", words: ["run", "command", "machine", "mycelium"] },
			{ address: "FZ9MFJ", words: ["web", "funnel"] },
		]);
	});

	it("reads none from a node that keeps no cells", () => {
		expect(foragersFrom(JSON.stringify({ id: 2, error: "no" }))).toEqual([]);
		expect(foragersFrom("not json")).toEqual([]);
	});
});

describe("the ties a need walks", () => {
	it("joins each tie at both ends, faded to now, strongest first, with when it was heard and who spoke", () => {
		const twoHours = AT - 2 * 60 * 60 * 1000;
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "tie:A~B", strength: 4, heard: AT, today: [0, 3] },
				{ key: "tie:A~C", strength: 8, heard: twoHours, today: [2, 0] },
				{ key: "tie:B~C", strength: 1, heard: AT, today: "none" },
				{ key: "tie:A", strength: 9, heard: AT },
			],
		});

		const graph = tieGraphFrom(line, AT);

		expect(graph.get("A")).toEqual([
			{ other: "B", strength: 4, heard: AT, spoke: false },
			{ other: "C", strength: 4, heard: twoHours, spoke: true },
		]);
		expect(graph.get("B")).toEqual([
			{ other: "A", strength: 4, heard: AT, spoke: true },
			{ other: "C", strength: 1, heard: AT, spoke: false },
		]);
		expect(graph.get("C")).toEqual([
			{ other: "A", strength: 4, heard: twoHours, spoke: false },
			{ other: "B", strength: 1, heard: AT, spoke: false },
		]);
	});
});

describe("the hubs a need is put to first", () => {
	it("reads each subject's hub and its fits", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "hub:carry", hub: "KP0L6A", fits: ["5HJZ8Z"], counted: AT },
				{ key: "hub:broken" },
			],
		});

		expect(hubsFrom(line)).toEqual([
			{ subject: "carry", hub: "KP0L6A", fits: ["5HJZ8Z"] },
		]);
	});

	it("reads each of the several hubs one subject's record lists, in place of its single one", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "hub:carry",
					hub: "OLD",
					fits: ["OLD"],
					hubs: [
						{ hub: "KP0L6A", fits: ["5HJZ8Z"] },
						{ hub: "9T2BBY", fits: ["9T2BBY", 7] },
						{ fits: ["X"] },
					],
					counted: AT,
				},
			],
		});

		expect(hubsFrom(line)).toEqual([
			{ subject: "carry", hub: "KP0L6A", fits: ["5HJZ8Z"] },
			{ subject: "carry", hub: "9T2BBY", fits: ["9T2BBY"] },
		]);
	});

	it("reads a record's single hub when its list names none", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "hub:carry", hub: "KP0L6A", fits: ["5HJZ8Z"], hubs: [] },
				{ key: "hub:easing", hub: "9T2BBY", fits: ["9T2BBY"], hubs: [7] },
				{
					key: "hub:lines",
					hub: "5HJZ8Z",
					fits: ["5HJZ8Z"],
					hubs: [{ fits: ["X"] }, { hub: "Y" }],
				},
			],
		});

		expect(hubsFrom(line)).toEqual([
			{ subject: "carry", hub: "KP0L6A", fits: ["5HJZ8Z"] },
			{ subject: "easing", hub: "9T2BBY", fits: ["9T2BBY"] },
			{ subject: "lines", hub: "5HJZ8Z", fits: ["5HJZ8Z"] },
		]);
	});

	it("reads none from a node that holds no hubs yet", () => {
		const refused = JSON.stringify({
			id: 2,
			error: { code: "unknown-kind", message: 'this node holds no "hub"' },
		});

		expect(hubsFrom(refused)).toEqual([]);
	});
});

describe("routing a need", () => {
	it("finds it already held when the asker works on every word", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: ["carry"], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: [], fit: "A" });
	});

	it("takes the tie to a cell working on it", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: ["web"], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("passes along ties until one works on it, each hop in its path", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: [], C: ["carry"] }),
			ties: ties(["A", "B", 1], ["B", "C", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["B", "C"], fit: "C" });
	});

	it("goes by its rarest word, which the fewest cells work on", () => {
		const found = routeNeed(asked("A", "mycelium", "carry"), {
			foragers: cells({
				A: [],
				B: ["mycelium"],
				C: ["mycelium"],
				D: ["mycelium", "carry"],
				E: ["mycelium"],
			}),
			ties: ties(["A", "B", 9], ["A", "C", 9], ["B", "D", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["B", "D"], fit: "D" });
	});

	it("takes, of the cells as near, the one working on most of it", () => {
		const found = routeNeed(asked("A", "carry", "tree"), {
			foragers: cells({ A: [], B: ["carry"], C: ["carry", "tree"] }),
			ties: ties(["A", "B", 9], ["A", "C", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["C"], fit: "C" });
	});

	// On 24 November "core nix gate checks" went to a cell on Delta's
	// signature checks, sharing only "checks", past every core.nix cell.
	it("goes to a cell working on more of it over the rarest word's only holder", () => {
		const found = routeNeed(asked("A", "core", "nix", "gate", "checks"), {
			foragers: cells({
				A: [],
				M: ["checks", "delta"],
				K: ["core", "nix"],
				L: ["core", "nix"],
				Z: ["gate", "aquifer"],
				Y: ["gate", "aquifer"],
			}),
			ties: ties(["A", "M", 9], ["A", "Z", 9], ["A", "K", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["K"], fit: "K" });
	});

	it("takes a walk's fit working on more of it over a hub's working on less", () => {
		const found = routeNeed(asked("A", "harness", "host", "gate"), {
			foragers: cells({
				A: [],
				Z: ["gate"],
				H: [],
				P: ["harness", "host"],
				Q: ["harness"],
			}),
			ties: ties(["A", "P", 1]),
			hubs: [{ subject: "gate", hub: "H", fits: ["Z"] }],
		});

		expect(found).toMatchObject({ path: ["P"], fit: "P" });
	});

	it("goes by the rarest word among fits working on as much of it", () => {
		const found = routeNeed(asked("A", "aquifer", "mint"), {
			foragers: cells({
				A: [],
				B: ["aquifer"],
				C: ["aquifer"],
				D: ["mint"],
			}),
			ties: ties(["A", "B", 9], ["A", "D", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["D"], fit: "D" });
	});

	it(`counts it lost past ${MOST_HOPS} hops, never sending it to a leader`, () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: [], C: [], D: [], E: ["carry"] }),
			ties: ties(["A", "B", 1], ["B", "C", 1], ["C", "D", 1], ["D", "E", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: [], fit: null });
	});

	it(`finds it at ${MOST_HOPS} hops, the last within reach`, () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: [], C: [], D: ["carry"] }),
			ties: ties(["A", "B", 1], ["B", "C", 1], ["C", "D", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["B", "C", "D"], fit: "D" });
	});

	it("goes by the words its asker doesn't work on, however rare the rest", () => {
		const found = routeNeed(asked("A", "mesh", "hubs"), {
			foragers: cells({
				A: ["mesh"],
				B: ["mesh"],
				C: ["hubs"],
				D: ["hubs"],
			}),
			ties: ties(["A", "B", 9], ["A", "C", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["C"], fit: "C" });
	});

	it("walks for the next rarest word when none near works on the rarest", () => {
		const found = routeNeed(asked("A", "carry", "tree"), {
			foragers: cells({ A: [], B: ["tree"], C: ["tree"], F: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("sets out from each of its asker's addresses, and takes none of them", () => {
		const found = routeNeed(
			{ ...asked("A", "carry"), selves: ["A2"] },
			{
				foragers: cells({ A: [], A2: [], B: ["carry"] }),
				ties: ties(["A", "A2", 9], ["A2", "B", 1]),
				hubs: [],
			},
		);

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("follows the strongest tie first, so of two as near it goes the stronger way", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: [], C: [], D: ["carry"] }),
			ties: ties(["A", "C", 9], ["A", "B", 1], ["B", "D", 1], ["C", "D", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: ["C", "D"], fit: "D" });
	});

	it("counts it lost when no cell works on any of it", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["web"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ path: [], fit: null });
	});

	it("neither fits nor passes through a cell that isn't there", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"], C: [], D: ["carry"] }),
			ties: ties(["A", "B", 9], ["A", "C", 1], ["C", "D", 1]),
			hubs: [],
			live: (address) => address !== "B",
		});

		expect(found).toMatchObject({ path: ["C", "D"], fit: "D" });
	});

	it("passes through no cell that has ended, though the shortest way is through it", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: [], C: [], E: [], D: ["carry"] }),
			ties: ties(
				["A", "B", 9],
				["B", "D", 9],
				["A", "C", 1],
				["C", "E", 1],
				["E", "D", 1],
			),
			hubs: [],
			live: (address) => address !== "B",
		});

		expect(found).toMatchObject({ path: ["C", "E", "D"], fit: "D" });
	});

	it("names every cell working on it when all of them have ended", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"], C: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
			live: (address) => address === "A",
		});

		expect(found).toMatchObject({ path: [], fit: null });
		expect([...(found.ended ?? [])].sort()).toEqual(["B", "C"]);
	});

	it("names a cell working on it that has ended, rather than skipping it unsaid", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({
				A: [],
				B: ["carry"],
				C: [],
				D: ["carry"],
				F: ["carry"],
			}),
			ties: ties(["A", "B", 9], ["A", "C", 1], ["C", "D", 1]),
			hubs: [{ subject: "carry", hub: "H", fits: ["F"] }],
			live: (address) => address !== "B" && address !== "F",
		});

		expect(found).toMatchObject({ path: ["C", "D"], fit: "D" });
		expect([...(found.ended ?? [])].sort()).toEqual(["B", "F"]);
	});

	it("names none ended that was passed over only for a word its fit wasn't found by", () => {
		const found = routeNeed(asked("A", "carry", "tree"), {
			foragers: cells({ A: [], C: ["carry", "tree"], E: ["tree"] }),
			ties: ties(["A", "E", 1], ["A", "C", 2]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found).toMatchObject({ path: ["C"], fit: "C" });
		expect(found).not.toHaveProperty("ended");
	});

	it("names none ended when every cell on the way is there", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).not.toHaveProperty("ended");
	});

	it("counts it lost, naming who ended and the fit, when an ended cell worked on more of it", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
				C: ["delivery"],
			}),
			ties: ties(["A", "B", 1], ["A", "C", 1], ["A", "J", 1]),
			hubs: [{ subject: "delivery", hub: "B", fits: ["B"] }],
			live: (address) => address !== "J",
		});

		expect(found, "B and C share only delivery").toMatchObject({
			path: [],
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
	});

	// An ended record out of reach is no more the need's owner than a live
	// cell there would be its fit, so its ending makes routing no stricter.
	it("counts no ended cell out of reach as its owner", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				J: ["dates", "delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "B", 1]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found, "J, untied, is passed by").toMatchObject({
			path: ["B"],
			fit: "B",
		});
		expect(found).not.toHaveProperty("fellShort");
	});

	// Each word's walk stops at its nearest fit, so routing would have
	// sent it to J, a hop out, were J back, and never to K behind C.
	it("counts it lost when its ended owner was nearer than a fuller live cell", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				J: ["dates", "delivery"],
				C: ["dates"],
				B: ["delivery"],
				K: ["dates", "delivery"],
			}),
			ties: ties(["A", "C", 2], ["A", "B", 2], ["A", "J", 1], ["C", "K", 1]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found, "J would have had it, not K").toMatchObject({
			path: [],
			fit: null,
			ended: ["J"],
			fellShort: "C",
		});
	});

	// Among fits on as much of it, every hub's find comes before any
	// walk's, whichever word is rarer.
	it("takes a hub's fit for one word before a walk's for another as narrow", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({ A: [], B: ["delivery"], K: ["dates"] }),
			ties: ties(["A", "K", 1]),
			hubs: [{ subject: "delivery", hub: "B", fits: ["B"] }],
		});

		expect(found, "dates sorts first, yet B's hub wins").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("names only the ended cells that worked on more of it than the fit", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				J: ["dates", "delivery"],
				E: ["delivery"],
				B: ["delivery"],
			}),
			ties: ties(["A", "E", 1], ["A", "B", 2], ["A", "J", 1]),
			hubs: [],
			live: (address) => address !== "J" && address !== "E",
		});

		expect(found, "E held no more of it than B").toMatchObject({
			fit: null,
			ended: ["J"],
			fellShort: "B",
		});
	});

	it("goes to the fit found when an ended cell held a word of it but no more of it", () => {
		// A record the node keeps after its session ended, holding a word
		// no live cell does, never stops a need a live cell works on as much.
		const found = routeNeed(asked("A", "niche", "delivery", "slots"), {
			foragers: cells({
				A: [],
				E: ["niche"],
				B: ["delivery", "slots"],
				C: ["delivery", "slots"],
			}),
			ties: ties(["A", "B", 1], ["A", "E", 1]),
			hubs: [],
			live: (address) => address !== "E",
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
		expect(found).not.toHaveProperty("fellShort");
	});

	it("goes by the word fewest cells hold, ended ones counted, when live holders tie", () => {
		const found = routeNeed(asked("A", "alpha", "zulu"), {
			foragers: cells({
				A: [],
				K: ["zulu"],
				B: ["alpha"],
				E1: ["alpha"],
				E2: ["alpha"],
			}),
			ties: ties(["A", "B", 1], ["A", "K", 2]),
			hubs: [],
			live: (address) => !address.startsWith("E"),
		});

		expect(found, "three cells held alpha, one zulu").toMatchObject({
			path: ["K"],
			fit: "K",
		});
	});

	it("goes by a word as narrow as one only an ended cell held, when a cell there holds it", () => {
		const found = routeNeed(asked("A", "dates", "slots"), {
			foragers: cells({ A: [], J: ["dates"], S: ["slots"] }),
			ties: ties(["A", "S", 1]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found).toMatchObject({ path: ["S"], fit: "S" });
	});

	it("goes by its narrowest word when a cell there holds it beside one that ended", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				J: ["dates"],
				K: ["dates"],
				B: ["delivery"],
				C: ["delivery"],
				D: ["delivery"],
			}),
			ties: ties(["A", "B", 9], ["A", "K", 1]),
			hubs: [],
			live: (address) => address !== "J",
		});

		expect(found).toMatchObject({ path: ["K"], fit: "K" });
	});

	it("goes by a broader word when its narrowest is held only by a cell that stopped the asker", () => {
		const found = routeNeed(asked("A", "dates", "delivery"), {
			foragers: cells({
				A: [],
				S: ["dates"],
				B: ["delivery"],
				C: ["delivery"],
			}),
			ties: ties(["A", "B", 1]),
			hubs: [],
			stopped: (address) => address === "S",
		});

		expect(found, "S won't hear A, so delivery routes it").toMatchObject({
			path: ["B"],
			fit: "B",
		});
	});

	it("puts it to the subject's hub first, which names the fit", () => {
		const hubs: Hub[] = [{ subject: "carry", hub: "H", fits: ["F"] }];
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"], H: [], F: ["carry"] }),
			ties: ties(["A", "B", 9]),
			hubs,
		});

		expect(found).toMatchObject({ path: ["H", "F"], fit: "F" });
	});

	it("passes once when the hub is itself the fit", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], H: ["carry"] }),
			ties: ties(),
			hubs: [{ subject: "carry", hub: "H", fits: ["H"] }],
		});

		expect(found).toMatchObject({ path: ["H"], fit: "H" });
	});

	it("takes the narrowest subject's hub over a broader one", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], F: ["carry"], G: ["carry"] }),
			ties: ties(),
			hubs: [
				{ subject: "carry", hub: "H", fits: ["F"] },
				{ subject: "mycelium:carry", hub: "N", fits: ["G"] },
			],
		});

		expect(found).toMatchObject({ path: ["N", "G"], fit: "G" });
	});

	it("walks the ties when the hub names no fit that is there", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"], F: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [{ subject: "carry", hub: "H", fits: ["F"] }],
			live: (address) => address !== "F",
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("keeps, of a text's words, only those some cell works on, so a token never lands in the file", () => {
		const found = routeNeed(
			{
				...asked("A"),
				words: wordsOf(`the carry broke on ghp_${"x9".repeat(20)}`),
				fromText: true,
			},
			{
				foragers: cells({ A: [], B: ["carry"] }),
				ties: ties(["A", "B", 1]),
				hubs: [],
			},
		);

		expect(found).toMatchObject({ words: ["carry"], fit: "B" });
	});

	it("keeps, of what it was said to be about, only words some cell works on", () => {
		const found = routeNeed(asked("A", "carry", "sk1x9q7tokenz"), {
			foragers: cells({ A: [], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toMatchObject({ words: ["carry"], fit: "B" });
	});

	it(`keeps at most ${MOST_WORDS} words, none past 32 characters, however it was said`, () => {
		const many = Array.from({ length: 14 }, (_, at) => `word${at}`);
		const long = "q".repeat(33);
		const found = routeNeed(asked("A", long, ...many), {
			foragers: cells({ A: [], B: [long, ...many] }),
			ties: ties(),
			hubs: [],
		});

		expect(found.words).toEqual(many.slice(0, MOST_WORDS));
	});

	it("writes the judge's line: the need, its asker and words, and the realm's size", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).toEqual({
			need: "A/1",
			asker: "A",
			words: ["carry"],
			path: ["B"],
			fit: "B",
			at: AT,
			cells: 2,
		});
	});
});

describe("a need's id", () => {
	it("is its asker's, and never the same twice in one moment", () => {
		const one = needId("A", AT);
		const two = needId("A", AT);

		expect(one).toMatch(new RegExp(`^A/${AT.toString(36)}\\.[0-9a-f]{12}$`));
		expect(two).not.toBe(one);
	});
});

describe("keeping a need", () => {
	it("adds one line a need to the day's file", async () => {
		const record = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		await keepNeed(root, record);
		await keepNeed(root, { ...record, need: "A/2" });

		const file = needsFile(root, AT);
		expect(file).toBe(join(root, "needs", "2026-11-17.jsonl"));
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).need)).toEqual(["A/1", "A/2"]);
	});
});

describe("keeping a need once an ask", () => {
	const routed = (asker: string, ...words: string[]) =>
		routeNeed(asked(asker, ...words), {
			foragers: cells({ A: [], C: [], B: ["carry", "fonts"] }),
			ties: ties(["A", "B", 1], ["C", "B", 1]),
			hubs: [],
		});
	const kept = () =>
		readFileSync(needsFile(root, AT), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).need);

	it("keeps the same ask sent again within ten minutes once", async () => {
		const first = routed("A", "carry");
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, {
			...first,
			need: "A/2",
			at: AT + NEED_AGAIN_MS - 1,
		});

		expect(kept()).toEqual(["A/1"]);
	});

	it("keeps it again once ten minutes have gone", async () => {
		const first = routed("A", "carry");
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, { ...first, need: "A/2", at: AT + NEED_AGAIN_MS });

		expect(kept()).toEqual(["A/1", "A/2"]);
	});

	it("keeps another asker's, other words, or another fit, as other asks", async () => {
		const first = routed("A", "carry");
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, { ...routed("C", "carry"), need: "C/1" });
		await keepNeedOnce(root, { ...routed("A", "fonts"), need: "A/2" });
		await keepNeedOnce(root, { ...first, need: "A/3", fit: null, path: [] });

		expect(kept()).toEqual(["A/1", "C/1", "A/2", "A/3"]);
	});

	it("reads past a torn line", async () => {
		const first = routed("A", "carry");
		await keepNeedOnce(root, first);
		writeFileSync(
			needsFile(root, AT),
			`${readFileSync(needsFile(root, AT), "utf8")}{"need":"A/9","ask\n`,
		);
		await keepNeedOnce(root, { ...first, need: "A/2" });

		const lines = readFileSync(needsFile(root, AT), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("reads past a torn line before the one it matches", async () => {
		const first = routed("A", "carry");
		mkdirSync(join(root, "needs"), { recursive: true });
		writeFileSync(needsFile(root, AT), '{"need":"A/9","ask\n');
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, { ...first, need: "A/2" });

		const lines = readFileSync(needsFile(root, AT), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("keeps an ask sent again across UTC midnight once", async () => {
		const midnight = Date.UTC(2026, 10, 18);
		const first = { ...routed("A", "carry"), at: midnight - 60_000 };
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, { ...first, need: "A/2", at: midnight + 60_000 });

		const before = readFileSync(needsFile(root, first.at), "utf8").trim();
		expect(before.split("\n").map((line) => JSON.parse(line).need)).toEqual([
			"A/1",
		]);
		expect(
			existsSync(needsFile(root, midnight)),
			"the ask sent again after midnight opened a file for the new day",
		).toBe(false);
	});

	it("keeps each ask with no words, since nothing tells two apart", async () => {
		const first = { ...routed("A", "carry"), words: [] };
		await keepNeedOnce(root, first);
		await keepNeedOnce(root, { ...first, need: "A/2" });

		expect(kept()).toEqual(["A/1", "A/2"]);
	});
});

describe("asking the node for a need's fit", () => {
	/**
	 * A node answering each daemon ask by its kind, with only the fields
	 * asked beside the key and kind, as the live node does.
	 */
	async function serving(kinds: Record<string, object[] | undefined>) {
		const socket = join(root, "work.sock");
		const server = createServer((client) => {
			client.setEncoding("utf8");
			let said = "";
			client.on("data", (chunk: string) => {
				said += chunk;
				for (let end = said.indexOf("\n"); end >= 0; end = said.indexOf("\n")) {
					const ask = JSON.parse(said.slice(0, end));
					said = said.slice(end + 1);
					const kept = new Set(["key", "kind", ...(ask.fields ?? [])]);
					const records = kinds[ask.kind]?.map((record) =>
						Object.fromEntries(
							Object.entries(record).filter(([field]) => kept.has(field)),
						),
					);
					const reply =
						ask.ask === "hello"
							? { id: ask.id, hello: true }
							: records
								? { id: ask.id, records }
								: { id: ask.id, error: { code: "unknown-kind" } };
					client.write(`${JSON.stringify(reply)}\n`);
				}
			});
		});
		servers.push(server);
		await new Promise<void>((listening) => server.listen(socket, listening));
		return socket;
	}

	it("routes over the node's cells and ties, with no hubs yet, and keeps the line", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:BBBBBB", title: "Carry a Session", repo: "mycelium" },
			],
			tie: [{ key: "tie:AAAAAA~BBBBBB", strength: 2, heard: AT }],
		});

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toMatchObject({
			path: ["BBBBBB"],
			fit: "BBBBBB",
			cells: 2,
		});
		expect(readFileSync(needsFile(root, AT), "utf8")).toContain(
			'"fit":"BBBBBB"',
		);
	});

	it("asks the node who sent on each tie today, so an ended owner is found", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:JJJJJJ", title: "Dates Delivery" },
				{ key: "cell:BBBBBB", title: "Delivery Lanes" },
			],
			tie: [
				{ key: "tie:AAAAAA~BBBBBB", strength: 3, heard: AT, today: [1, 1] },
				{ key: "tie:AAAAAA~JJJJJJ", strength: 1, heard: AT, today: [0, 1] },
			],
		});

		const found = await needAt(socket, asked("AAAAAA", "dates", "delivery"), {
			live: (address) => address !== "JJJJJJ",
			stopped: () => false,
			keep: root,
		});

		expect(found, "J's own sending on its tie").toMatchObject({
			fit: null,
			ended: ["JJJJJJ"],
			fellShort: "BBBBBB",
		});
	});

	it("keeps a lost need as it is routed", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:BBBBBB", title: "Carry a Session", repo: "mycelium" },
			],
			tie: [{ key: "tie:AAAAAA~BBBBBB", strength: 2, heard: AT }],
		});

		const found = await needAt(socket, asked("AAAAAA", "fonts"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toMatchObject({ fit: null });
		expect(readFileSync(needsFile(root, AT), "utf8")).toContain('"fit":null');
	});

	it("asks the node for each cell's subjects, and routes by them", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{
					key: "cell:BBBBBB",
					title: "Carry a Session",
					subjects: ["mycelium:easing"],
				},
			],
			tie: [{ key: "tie:AAAAAA~BBBBBB", strength: 2, heard: AT }],
		});

		const found = await needAt(socket, asked("AAAAAA", "easing"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(
			found,
			"a need finds the cell that declares its subject",
		).toMatchObject({ path: ["BBBBBB"], fit: "BBBBBB" });
	});

	it("asks the node for a subject's several hubs, and routes by them", async () => {
		// F has no tie from A, so only its hub can lead the need there, and
		// only the list's second hub names it.
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:HHHHHH", title: "Hub" },
				{ key: "cell:FFFFFF", title: "Carry a Session" },
			],
			tie: [{ key: "tie:AAAAAA~HHHHHH", strength: 2, heard: AT }],
			hub: [
				{
					key: "hub:carry",
					hubs: [
						{ hub: "HHHHHH", fits: ["XXXXXX"] },
						{ hub: "HHHHHH", fits: ["FFFFFF"] },
					],
				},
			],
		});

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toMatchObject({
			path: ["HHHHHH", "FFFFFF"],
			fit: "FFFFFF",
		});
	});

	it("asks the node for a record's single hub, as a node from before the list writes it", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:HHHHHH", title: "Hub" },
				{ key: "cell:FFFFFF", title: "Carry a Session" },
			],
			tie: [{ key: "tie:AAAAAA~HHHHHH", strength: 2, heard: AT }],
			hub: [{ key: "hub:carry", hub: "HHHHHH", fits: ["FFFFFF"] }],
		});

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toMatchObject({
			path: ["HHHHHH", "FFFFFF"],
			fit: "FFFFFF",
		});
	});

	it("answers nothing, and keeps nothing, when no node answers", async () => {
		const found = await needAt(join(root, "none.sock"), asked("A", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toBeUndefined();
		expect(
			existsSync(needsFile(root, AT)),
			"no needs record kept when no node answers",
		).toBe(false);
	});

	it("answers nothing, never a lost need, when the node won't list its ties", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:BBBBBB", title: "Carry a Session" },
			],
		});

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: root,
		});

		expect(found).toBeUndefined();
		expect(
			existsSync(needsFile(root, AT)),
			"no needs record kept when the node won't list its ties",
		).toBe(false);
	});

	it("still answers when the needs folder won't take the line", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:BBBBBB", title: "Carry a Session" },
			],
			tie: [{ key: "tie:AAAAAA~BBBBBB", strength: 2, heard: AT }],
		});
		// A file where the folder would go, so its needs/ can't be made.
		const file = join(root, "a-file");
		writeFileSync(file, "");

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: () => false,
			keep: file,
		});

		expect(found).toMatchObject({ fit: "BBBBBB" });
	});

	it("takes no cell that stopped the asker, and finds through it", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:AAAAAA", title: "A Web, Not a Funnel" },
				{ key: "cell:SSSSSS", title: "Carry a Session" },
				{ key: "cell:FFFFFF", title: "Carry a Tree" },
			],
			tie: [
				{ key: "tie:AAAAAA~SSSSSS", strength: 2, heard: AT },
				{ key: "tie:SSSSSS~FFFFFF", strength: 2, heard: AT },
			],
		});

		const found = await needAt(socket, asked("AAAAAA", "carry"), {
			live: () => true,
			stopped: (address) => address === "SSSSSS",
			keep: root,
		});

		expect(found, "F, one tie past S, never S").toMatchObject({
			path: ["SSSSSS", "FFFFFF"],
			fit: "FFFFFF",
		});
	});
});
