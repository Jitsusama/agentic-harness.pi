import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	slotOf,
	writeSlot,
	writeSpareSlot,
} from "../../host/service/child-units.ts";
import {
	type HeapSummary,
	writeSummary,
} from "../../host/service/heap-summary.ts";
import type { MemoryAnswer } from "../../host/service/protocol.ts";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import {
	askedOf,
	childRunning,
	describeChild,
	describeMemory,
	describeSnapshot,
	describeSnapshotFailure,
	describeSummary,
	SNAPSHOT_ASKER,
	snapshotAt,
} from "../../scripts/host-memory.ts";

const MIB = 1024 * 1024;
/** Long enough to ask, short enough that a summary never coming is quick to see. */
const SHORT_WAIT_MS = 400;
const POLL_MS = 50;
/** A summary, its last name holding a control character. */
const FIGURES: HeapSummary = {
	nodes: 30_000,
	selfSize: 2 * MIB,
	byType: [
		{ type: "object", count: 20_000, selfSize: 1.5 * MIB },
		{ type: "string", count: 10_000, selfSize: 0.5 * MIB },
	],
	byTypeAndName: [
		{ type: "object", name: "MarkedThing", count: 1000, selfSize: MIB },
		{ type: "string", count: 10_000, selfSize: 0.5 * MIB },
		{
			type: "object",
			name: "Obj\u001bect",
			count: 19_000,
			selfSize: 0.5 * MIB,
		},
	],
	largeStrings: { atLeast: 64 * 1024, count: 1, selfSize: 100 * 1024 },
};
const AT = "2026-11-24T08:00:00.000Z";
const ONE = "01a1cf4a-a681-7237-bce7-2ce6dbc70547";
const TWO = "01a1ccd0-1fc8-7057-8e8c-4577817aa50d";
const THREE = "01a1f00d-0000-7000-8000-000000000001";

const host: MemoryAnswer["host"] = {
	key: "work-background",
	owner: { pid: 1200, startedAt: 1 },
};

/** A conversation whose child said `heap` MiB and was read at `pss` MiB. */
function inChild(sessionId: string, pss: number, heap: number) {
	return {
		sessionId,
		state: "idle" as const,
		pss: pss * MIB,
		heap: { used: heap * MIB, limit: 4096 * MIB, at: AT },
	};
}

describe("a host's memory, described", () => {
	it("gives the host's own, then each conversation's, with the children's median and total", () => {
		const lines = describeMemory("background", {
			host,
			own: {
				pss: 150 * MIB,
				heap: { used: 60 * MIB, limit: 4096 * MIB, at: AT },
			},
			// Out of order, and 90 MiB in bytes sorts last as text: the median
			// is 200 only when the readings are sorted as numbers.
			sessions: [
				inChild(THREE, 600, 300),
				inChild(ONE, 90, 50),
				inChild(TWO, 200, 90),
			],
		});

		expect(lines[0]).toBe(
			"background: host Pss 150 MiB, heap 60 of 4096 MiB; a child's Pss read for 3 of 3 conversations, median 200 MiB, total 890 MiB",
		);
		expect(lines[1]).toBe(
			"  spaces: not said, by an install older than this script",
		);
		expect(lines[3]).toMatch(
			new RegExp(`^ {2}Pss 90 MiB +heap 50 of 4096 MiB +${AT} +idle +${ONE}$`),
		);
		expect(lines).toHaveLength(5);
	});

	it("takes an even count's median between its middle two", () => {
		const [said] = describeMemory("attended", {
			host,
			own: {},
			sessions: [inChild(ONE, 100, 50), inChild(TWO, 200, 90)],
		});

		expect(said).toContain(", median 150 MiB, total 300 MiB");
	});

	it("says unread, never 0, where the host took no reading, and leaves those out of the children's", () => {
		const lines = describeMemory("attended", {
			host,
			own: {},
			sessions: [{ sessionId: ONE, state: "parked" }, inChild(TWO, 200, 90)],
		});

		expect(lines[0]).toBe(
			"attended: host Pss unread, heap unread; a child's Pss read for 1 of 2 conversations, median 200 MiB, total 200 MiB",
		);
		expect(lines[1]).toMatch(
			new RegExp(`^ {2}Pss unread +heap unread +parked +${ONE}$`),
		);
	});

	it("gives a child's own Pss and heap, then each of its spaces, largest first", () => {
		const lines = describeChild(`background child ${ONE}`, {
			host,
			own: {
				pss: 270 * MIB,
				heap: {
					used: 168 * MIB,
					limit: 4096 * MIB,
					at: AT,
					spaces: [
						{ name: "code_space", used: 9 * MIB, size: 10 * MIB },
						{ name: "old_space", used: 150 * MIB, size: 160 * MIB },
						{ name: "large_object_space", used: 7 * MIB, size: 7 * MIB },
					],
					external: 12 * MIB,
					arrayBuffers: 3 * MIB,
				},
			},
			sessions: [{ sessionId: ONE, state: "busy" }],
		});

		expect(lines).toEqual([
			`background child ${ONE}: Pss 270 MiB, heap 168 of 4096 MiB`,
			"  spaces: old_space 150 of 160 MiB, code_space 9 of 10 MiB, large_object_space 7 of 7 MiB; external 12 MiB, array buffers 3 MiB",
		]);
	});

	it("prints a space's name with nothing a terminal would act on", () => {
		const [, spaces] = describeChild("attended child", {
			host,
			own: {
				heap: {
					used: MIB,
					limit: 4096 * MIB,
					at: AT,
					spaces: [{ name: "old\u001b[2Jspace", used: MIB, size: MIB }],
				},
			},
			sessions: [],
		});

		expect(spaces).not.toContain("\u001b");
	});

	it("reads a host's kind, or a kind and a conversation's id, and nothing else", () => {
		expect(askedOf("background")).toEqual({ kind: "background" });
		expect(askedOf(`attended:${ONE}`)).toEqual({
			kind: "attended",
			session: ONE,
		});
		expect(askedOf("elsewhere"), "no such kind").toBeUndefined();
		expect(askedOf("background:../x"), "no path for an id").toBeUndefined();
		expect(askedOf(`background:${ONE}:x`)).toBeUndefined();
	});

	it("reads an id in either case, as a roster takes one", () => {
		expect(askedOf(`background:${ONE.toUpperCase()}`)).toEqual({
			kind: "background",
			session: ONE.toUpperCase(),
		});
	});

	it("says no child's Pss was read when none was", () => {
		const [said] = describeMemory("attended", {
			host,
			own: { pss: 80 * MIB },
			sessions: [{ sessionId: ONE, state: "parked" }],
		});

		expect(said).toBe(
			"attended: host Pss 80 MiB, heap unread; no child's Pss read",
		);
	});
});

describe("a heap snapshot, described", () => {
	it("says where it went, its size and how long the process stopped", () => {
		const said = { sessionId: ONE, bytes: 412 * MIB, tookMs: 3100 };
		expect(
			describeSnapshot({
				...said,
				file: "/state/heap-snapshots/one.heapsnapshot",
			}),
		).toBe(
			`${ONE}: a heap snapshot of 412 MiB, written in 3100 ms, to /state/heap-snapshots/one.heapsnapshot`,
		);
		expect(
			describeSnapshot({ ...said, file: "/state/one\u001b[2J.heapsnapshot" }),
			"nothing a terminal would act on",
		).not.toContain("\u001b");
	});

	it("says a request that gave up waiting may still see its file come, and when it goes", () => {
		expect(
			describeSnapshotFailure(
				`background:${ONE}`,
				new Error("Host control request timed out; outcome unknown"),
			),
		).toBe(
			`background:${ONE}: no snapshot: Host control request timed out; outcome unknown; the host may still be writing it into its heap-snapshots folder, where the next snapshot removes it once 2 hours old`,
		);
		expect(
			describeSnapshotFailure(
				`background:${ONE}`,
				new Error("it refused: it is busy"),
			),
			"a refusal says no more than itself",
		).toBe(`background:${ONE}: no snapshot: it refused: it is busy`);
	});
});

describe("the child a conversation runs in, found", () => {
	const KEY = "work-background";
	let folder = "";

	beforeEach(async () => {
		folder = await mkdtemp(join(tmpdir(), "host-memory-"));
	});

	afterEach(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	/** A conversation as a slot's file holds it. */
	function rosterEntry(sessionId: string): RosterEntry {
		return {
			sessionId,
			file: join(folder, `${sessionId}.jsonl`),
			cwd: folder,
			attended: false,
			since: AT,
		};
	}

	/** The memory answer of a child that runs `sessionId`. */
	function running(sessionId: string): MemoryAnswer {
		return { host, own: { pss: MIB }, sessions: [inChild(sessionId, 1, 1)] };
	}

	it("finds one an open started in a slot of its own, by what it answers", async () => {
		// An open's child listens in a fresh slot, its file naming nothing yet.
		const other = slotOf(folder, KEY, TWO);
		const opened = slotOf(folder, KEY, THREE);
		await writeSlot(other, rosterEntry(TWO));
		await writeSlot(opened, undefined);
		const asked: string[] = [];

		const answer = await childRunning(folder, KEY, ONE, async (socket) => {
			asked.push(socket);
			if (socket === opened.socket) return running(ONE);
			if (socket === other.socket) return running(TWO);
			return undefined;
		});

		expect(answer?.sessions[0]?.sessionId).toBe(ONE);
		expect(asked[0], "the slot its id names, asked first").toBe(
			slotOf(folder, KEY, ONE).socket,
		);
	});

	it("asks a slot whose file says it holds the conversation before the rest", async () => {
		const spare = slotOf(folder, KEY, TWO);
		const holding = slotOf(folder, KEY, THREE);
		await writeSpareSlot(spare);
		await writeSlot(holding, rosterEntry(ONE));
		const asked: string[] = [];

		await childRunning(folder, KEY, ONE, async (socket) => {
			asked.push(socket);
			return socket === holding.socket ? running(ONE) : undefined;
		});

		expect(asked).toEqual([slotOf(folder, KEY, ONE).socket, holding.socket]);
	});

	it("finds none when no child says it runs the conversation", async () => {
		await writeSlot(slotOf(folder, KEY, TWO), rosterEntry(TWO));

		const answer = await childRunning(folder, KEY, ONE, async () =>
			running(TWO),
		);

		expect(answer).toBeUndefined();
	});
});

describe("a heap snapshot, asked", () => {
	const WAIT_MS = 5000;
	let dir: string;
	let server: Server | undefined;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "host-memory-snapshot-"));
	});
	afterEach(async () => {
		server?.close();
		server = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * A host on a socket that answers each request as `answer` says,
	 * keeping every request it was sent.
	 */
	async function hostAnswering(
		answer: (request: Record<string, unknown>) => unknown,
	): Promise<{ socket: string; asked: Record<string, unknown>[] }> {
		const socket = join(dir, "host.sock");
		const asked: Record<string, unknown>[] = [];
		server = createServer((connection) => {
			let held = "";
			connection.on("data", (chunk: Buffer) => {
				held += chunk.toString("utf8");
				const lf = held.indexOf("\n");
				if (lf === -1) return;
				const request = JSON.parse(held.slice(0, lf));
				asked.push(request);
				connection.end(`${JSON.stringify(answer(request))}\n`);
			});
		});
		const listening = server;
		await new Promise<void>((resolve) => listening.listen(socket, resolve));
		return { socket, asked };
	}

	const written = (request: Record<string, unknown>) => ({
		v: 1,
		id: request.id,
		ok: true,
		result: {
			sessionId: ONE,
			file: "/state/heap-snapshots/one.heapsnapshot",
			bytes: MIB,
			tookMs: 40,
		},
	});

	it("names this script as who asks, for the host's journal", async () => {
		const host = await hostAnswering(written);

		const said = await snapshotAt(host.socket, ONE, { waitMs: WAIT_MS });

		expect(said).toEqual({
			lines: [
				`${ONE}: a heap snapshot of 1 MiB, written in 40 ms, to /state/heap-snapshots/one.heapsnapshot`,
				"  no summary: the host runs code from before summaries, so the raw file is kept; remove it once read",
			],
			done: true,
		});
		expect(host.asked).toEqual([
			expect.objectContaining({
				op: "heap-snapshot",
				sessionId: ONE,
				by: "scripts/host-memory.ts",
			}),
		]);
		expect(SNAPSHOT_ASKER).toBe("scripts/host-memory.ts");
	});

	it("asks a host on code older than who asks once more, without", async () => {
		// Such a host reads a request carrying `by` as no request at all.
		const host = await hostAnswering((request) =>
			"by" in request
				? {
						v: 1,
						id: null,
						ok: false,
						error: {
							code: "invalid_request",
							message: "Invalid host control request",
						},
					}
				: written(request),
		);

		const said = await snapshotAt(host.socket, ONE, { waitMs: WAIT_MS });

		expect(said.lines[0]).toContain("a heap snapshot of 1 MiB");
		expect(host.asked.map((request) => "by" in request)).toEqual([true, false]);
	});

	it("asks only once when the host refuses for any other reason", async () => {
		const host = await hostAnswering((request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: { code: "busy", message: "it is busy" },
		}));

		await expect(
			snapshotAt(host.socket, ONE, { waitMs: WAIT_MS }),
		).rejects.toThrow("it refused: it is busy");
		expect(host.asked).toHaveLength(1);
	});

	/** A snapshot's raw file in the test's folder, and where its summary goes. */
	async function rawAndSummary(): Promise<{ raw: string; summary: string }> {
		const raw = join(dir, "one.heapsnapshot");
		await writeFile(raw, "raw");
		return { raw, summary: join(dir, "one.summary.json") };
	}

	/** A host answering that it wrote `raw`, whose summary goes to `summary`. */
	const summing =
		(raw: string, summary: string) => (request: Record<string, unknown>) => ({
			...written(request),
			result: { sessionId: ONE, file: raw, summary, bytes: MIB, tookMs: 40 },
		});

	it("prints the summary's figures, then removes the raw file, since it summed it", async () => {
		const { raw, summary } = await rawAndSummary();
		writeSummary(FIGURES, summary);
		const host = await hostAnswering(summing(raw, summary));

		const said = await snapshotAt(host.socket, ONE, { waitMs: WAIT_MS });

		expect(said.lines).toEqual([
			`${ONE}: a heap snapshot of 1 MiB, written in 40 ms, to ${raw}`,
			...describeSummary(FIGURES),
			`  removed the raw snapshot at ${raw}, since this summed it; --keep-raw keeps one for a retainers read`,
		]);
		expect(said.done).toBe(true);
		await expect(stat(raw), "the raw file is gone").rejects.toThrow("ENOENT");
		expect(await readFile(summary, "utf8"), "the summary stays").toContain(
			"MarkedThing",
		);
	});

	it("keeps the raw file, once summed, when asked to keep it", async () => {
		const { raw, summary } = await rawAndSummary();
		writeSummary(FIGURES, summary);
		const host = await hostAnswering(summing(raw, summary));

		const said = await snapshotAt(host.socket, ONE, {
			waitMs: WAIT_MS,
			keepRaw: true,
		});

		expect(said.lines.at(-1)).toBe(
			`  kept the raw snapshot at ${raw}, as --keep-raw asked; remove it once read, or the host does once 2 hours old`,
		);
		expect(said.lines).toEqual(
			expect.arrayContaining(describeSummary(FIGURES)),
		);
		expect(said.done).toBe(true);
		expect(await readFile(raw, "utf8")).toBe("raw");
	});

	it("keeps the raw file, and says it isn't done, when no summary comes in time", async () => {
		const { raw, summary } = await rawAndSummary();
		// Half a summary, as one still being written reads.
		await writeFile(summary, "{");
		const host = await hostAnswering(summing(raw, summary));

		const said = await snapshotAt(host.socket, ONE, {
			waitMs: SHORT_WAIT_MS,
			pollMs: POLL_MS,
		});

		expect(said.lines.at(-1)).toBe(
			`  no summary came to ${summary} in time, so the raw file is kept; the host's journal says whether its sum failed`,
		);
		expect(said.done).toBe(false);
		expect(await readFile(raw, "utf8")).toBe("raw");
	});
});

describe("a heap snapshot's summary, described", () => {
	it("gives its totals, each kind, then the largest kinds and names, as a table", () => {
		expect(describeSummary(FIGURES)).toEqual([
			"  30000 nodes, 2.0 MiB in all; strings of 64 KiB or more: 1, 0.1 MiB",
			"      self size      count  kind",
			"        1.5 MiB      20000  object",
			"        0.5 MiB      10000  string",
			"      self size      count  kind and name, the largest 3 of 3",
			"        1.0 MiB       1000  object: MarkedThing",
			"        0.5 MiB      10000  string",
			"        0.5 MiB      19000  object: Obj?ect",
		]);
	});
});
