/**
 * A need put to what it is about: to the subject's hub where there is
 * one, else along the node's ties, each hop kept as one line the scale
 * run's judge reads.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	type NeedAsked,
	needAt,
	needsFile,
	routeNeed,
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
		expect(wordsOf("Run a Command on Any Machine of the Realm, the realm")).toEqual(
			["run", "command", "machine", "realm"],
		);
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

describe("asking the node for a need's fit", () => {
	/** A node answering each daemon ask by its kind. */
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
					const records = kinds[ask.kind];
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

	it("answers nothing, and keeps nothing, when no node answers", async () => {
		const found = await needAt(join(root, "none.sock"), asked("A", "carry"), {
			live: () => true,
			keep: root,
		});

		expect(found).toBeUndefined();
	});
});
