/**
 * A need put to what it is about: to the subject's hub where there is
 * one, else along the node's ties, each hop kept as one line the scale
 * run's judge reads.
 */

import {
	existsSync,
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
	type Forager,
	foragersFrom,
	type Hub,
	hubsFrom,
	keepNeed,
	MOST_HOPS,
	MOST_SUBJECTS,
	MOST_WORDS,
	type NeedAsked,
	needAt,
	needId,
	needsFile,
	type Reach,
	routeNeed as routeOver,
	subjectWords,
	type TieGraph,
	tieGraphFrom,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";

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

const AT = Date.UTC(2026, 10, 17, 19, 0, 0);

/** A need asked by `asker` about `words`, at a fixed moment. */
const asked = (asker: string, ...words: string[]): NeedAsked => ({
	need: `${asker}/1`,
	asker,
	words,
	at: AT,
});

/** A need routed where every cell is there unless `live` says not. */
const routeNeed = (
	need: NeedAsked,
	reach: Omit<Reach, "live"> & Partial<Pick<Reach, "live">>,
) => routeOver(need, { live: () => true, ...reach });

/** Cells with the words each works on. */
const cells = (held: Record<string, string[]>): Forager[] =>
	Object.entries(held).map(([address, words]) => ({ address, words }));

/** Ties as pairs of ends, each as strong as given, both ways. */
const ties = (...pairs: [string, string, number][]): TieGraph => {
	const graph = new Map<string, { other: string; strength: number }[]>();
	for (const [one, other, strength] of pairs) {
		graph.set(one, [...(graph.get(one) ?? []), { other, strength }]);
		graph.set(other, [...(graph.get(other) ?? []), { other: one, strength }]);
	}
	return graph;
};

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

	it("reads at most MOST_SUBJECTS subjects from one cell", () => {
		const subjects = Array.from(
			{ length: MOST_SUBJECTS + 1 },
			(_, at) => `stuffed:word${at}`,
		);
		const line = JSON.stringify({
			id: 2,
			records: [{ key: "cell:X", subjects }],
		});

		const [cell] = foragersFrom(line);

		expect(cell?.words).toHaveLength(MOST_SUBJECTS);
		expect(cell?.words, "the subject past the cap is not read").not.toContain(
			`word${MOST_SUBJECTS}`,
		);
	});

	it("reads none from a node that keeps no cells", () => {
		expect(foragersFrom(JSON.stringify({ id: 2, error: "no" }))).toEqual([]);
		expect(foragersFrom("not json")).toEqual([]);
	});
});

describe("the ties a need walks", () => {
	it("joins each tie at both ends, faded to now, strongest first", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "tie:A~B", strength: 4, heard: AT },
				{ key: "tie:A~C", strength: 8, heard: AT - 2 * 60 * 60 * 1000 },
				{ key: "tie:A", strength: 9, heard: AT },
			],
		});

		const graph = tieGraphFrom(line, AT);

		expect(graph.get("A")).toEqual([
			{ other: "B", strength: 4 },
			{ other: "C", strength: 4 },
		]);
		expect(graph.get("C")).toEqual([{ other: "A", strength: 4 }]);
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

	it("names none ended when every cell on the way is there", () => {
		const found = routeNeed(asked("A", "carry"), {
			foragers: cells({ A: [], B: ["carry"] }),
			ties: ties(["A", "B", 1]),
			hubs: [],
		});

		expect(found).not.toHaveProperty("ended");
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

describe("a need routed by declared subjects", () => {
	it("reaches the cell declaring its subject past a nearer one holding a generic word", () => {
		// The first live need: `lines` was in another cell's title, and no
		// title said easing.
		const found = routeNeed(asked("A", "mycelium", "easing", "lines"), {
			foragers: [
				...cells({ A: ["web", "funnel"], W: ["command", "lines"] }),
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

		expect(found.words).toHaveLength(MOST_WORDS);
		expect(found.words, "the rarest word is kept").toContain("rare");
		expect(found.fit).toBe("C");
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

		expect(found, "the longer subject, the narrower, wins").toMatchObject({
			fit: "F",
			path: ["H", "F"],
		});
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
				{ key: "cell:A", title: "A Web, Not a Funnel" },
				{ key: "cell:B", title: "Carry a Session", repo: "mycelium" },
			],
			tie: [{ key: "tie:A~B", strength: 2, heard: AT }],
		});

		const found = await needAt(socket, asked("A", "carry"), {
			live: () => true,
			keep: root,
		});

		expect(found).toMatchObject({ path: ["B"], fit: "B", cells: 2 });
		expect(readFileSync(needsFile(root, AT), "utf8")).toContain('"fit":"B"');
	});

	it("asks the node for each cell's subjects, and routes by them", async () => {
		const socket = await serving({
			cell: [
				{ key: "cell:A", title: "A Web, Not a Funnel" },
				{
					key: "cell:B",
					title: "Carry a Session",
					subjects: ["mycelium:easing"],
				},
			],
			tie: [{ key: "tie:A~B", strength: 2, heard: AT }],
		});

		const found = await needAt(socket, asked("A", "easing"), {
			live: () => true,
			keep: root,
		});

		expect(
			found,
			"a need finds the cell that declares its subject",
		).toMatchObject({ path: ["B"], fit: "B" });
	});

	it("answers nothing, and keeps nothing, when no node answers", async () => {
		const found = await needAt(join(root, "none.sock"), asked("A", "carry"), {
			live: () => true,
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
				{ key: "cell:A", title: "A Web, Not a Funnel" },
				{ key: "cell:B", title: "Carry a Session" },
			],
		});

		const found = await needAt(socket, asked("A", "carry"), {
			live: () => true,
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
				{ key: "cell:A", title: "A Web, Not a Funnel" },
				{ key: "cell:B", title: "Carry a Session" },
			],
			tie: [{ key: "tie:A~B", strength: 2, heard: AT }],
		});
		// A file where the folder would go, so its needs/ can't be made.
		const file = join(root, "a-file");
		writeFileSync(file, "");

		const found = await needAt(socket, asked("A", "carry"), {
			live: () => true,
			keep: file,
		});

		expect(found).toMatchObject({ fit: "B" });
	});
});
