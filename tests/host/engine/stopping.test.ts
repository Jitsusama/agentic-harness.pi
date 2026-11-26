/**
 * What a start's reaps read: between resuming and resumed, the table is
 * read once for the first reap of every conversation the start holds,
 * and every other reap (a held one's second, one the start doesn't hold,
 * one after a failed reading, or any outside a start) reads it whole;
 * and the start's reap of the whole key spares what a child parked, and
 * is tried again each STRAY_LOOK_MS while it waits, until it doesn't.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRAY_LOOK_MS } from "../../../host/engine/carried-shells.ts";
import { LEFT_FILE } from "../../../host/engine/left-running.ts";
import { carryEnds, stopKeeping } from "../../../host/engine/stopping.ts";
import {
	conversationMarker,
	type ProcessTable,
} from "../../../host/engine/tool-children.ts";
import { holdForCarry } from "../../../lib/internal/carry/under-way.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";

/** A folder whose listing is to fail for the moment, as a process out of descriptors would. */
const listFault = vi.hoisted(() => ({
	folder: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const readdir = ((...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === listFault.folder)
			return Promise.reject(
				Object.assign(new Error("EMFILE: as the test asked"), {
					code: "EMFILE",
				}),
			);
		return fs.readdir(...args);
	}) as typeof fs.readdir;
	return { ...fs, readdir };
});

/** The host the table's processes ran under: pid 1, started at tick 0. */
const HOST = { key: "test-host", mark: "1:0" };

/** A table of marked processes that counts how often it is listed whole. */
function countingTable(
	envs: Record<number, Record<string, string>>,
	failing = 0,
): ProcessTable & {
	listed: number;
	killed: number[];
	live: Map<number, Record<string, string>>;
} {
	const live = new Map(
		Object.entries(envs).map(([pid, env]) => [Number(pid), env]),
	);
	const table = {
		self: 1,
		listed: 0,
		killed: [] as number[],
		live,
		pids: () => {
			table.listed += 1;
			if (table.listed <= failing) throw new Error("/proc refused");
			return [...live.keys()];
		},
		environ: async (pid: number) => live.get(pid),
		group: (pid: number) => (live.has(pid) ? pid : undefined),
		cgroup: () => undefined,
		started: (pid: number) => (live.has(pid) ? 0 : undefined),
		kill: (target: { group: number } | { pid: number }) => {
			const pid = "group" in target ? target.group : target.pid;
			table.killed.push(pid);
			live.delete(pid);
		},
	};
	return table;
}

describe("a start's reaps", () => {
	const dirs: string[] = [];
	afterEach(() => {
		listFault.folder = undefined;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
	});
	function keeping(
		table: ProcessTable,
		reported: unknown[] = [],
		kept: readonly { session: string; mark: string }[] = [],
		every?: (ms: number, run: () => void) => () => void,
	) {
		const stateDir = mkdtempSync(join(tmpdir(), "stopping-"));
		dirs.push(stateDir);
		if (kept.length > 0)
			writeFileSync(
				join(stateDir, LEFT_FILE),
				JSON.stringify(kept.map((call) => ({ ...call, at: Date.now() }))),
			);
		return stopKeeping({
			stateDir,
			report: (error) => reported.push(error),
			table,
			...(every ? { every } : {}),
		});
	}

	it("read the table once for every conversation's first reap", async () => {
		const table = countingTable({
			1: {},
			10: conversationMarker("z", HOST),
			30: {},
		});
		const stopping = keeping(table);
		stopping.resuming(["a", "b", "c"]);
		await Promise.all([
			stopping.reap("a"),
			stopping.reap("b"),
			stopping.reap("c"),
		]);
		expect(table.listed, "one reading for all three").toBe(1);
		expect(table.killed, "none of theirs ran").toEqual([]);
	});

	it("still kill what the start's reading named", async () => {
		const table = countingTable({
			1: {},
			10: conversationMarker("a", HOST),
			20: conversationMarker("b", HOST),
		});
		const stopping = keeping(table);
		stopping.resuming(["a", "b"]);
		await stopping.reap("a");
		await stopping.reap("b");
		expect(table.killed).toEqual([10, 20]);
	});

	it("read it whole for a conversation the start doesn't hold, whose tools may have started since", async () => {
		const table = countingTable({ 1: {}, 10: conversationMarker("z", HOST) });
		const stopping = keeping(table);
		stopping.resuming(["a"]);
		await stopping.reap("a");
		// Opened, adopted or put in a seat by pi's replacement during the start.
		table.live.set(40, conversationMarker("n", HOST));
		await stopping.reap("n");
		expect(
			table.listed,
			"the start's, then its own, and again once it kills",
		).toBe(3);
		expect(table.killed, "what it started after the start's reading").toEqual([
			40,
		]);
	});

	it("read it whole for a held conversation's close, whose kept command may have started more since", async () => {
		const kept = { ...conversationMarker("a", HOST), [CALL_VARIABLE]: "k1" };
		const table = countingTable({ 1: {}, 10: kept });
		const stopping = keeping(table, [], [{ session: "a", mark: "k1" }]);
		stopping.resuming(["a", "b"]);
		await stopping.reap("b");
		// The kept command started a child after the start's reading, then ended.
		table.live.set(50, kept);
		table.live.delete(10);
		await stopping.dropped("a");
		expect(table.killed, "the child the reading never saw").toEqual([50]);
	});

	it("read it whole for a conversation handed on and back during the start, whose first reap the start no longer owes", async () => {
		const table = countingTable({ 1: {}, 10: conversationMarker("z", HOST) });
		const stopping = keeping(table);
		stopping.resuming(["a", "b"]);
		stopping.handsOn("a");
		await stopping.dropped("a");
		await stopping.reap("b");
		// Adopted back after the start's reading, with a tool of its own.
		table.live.set(60, conversationMarker("a", HOST));
		await stopping.reap("a");
		expect(table.killed, "what it started after the reading").toEqual([60]);
	});

	it("say a failed reading once, and each reap then reads for itself", async () => {
		const table = countingTable(
			{
				1: {},
				10: conversationMarker("a", HOST),
				20: conversationMarker("b", HOST),
			},
			1,
		);
		const reported: unknown[] = [];
		const stopping = keeping(table, reported);
		stopping.resuming(["a", "b", "c"]);
		// Together, so all three hear the one failed reading.
		await Promise.all([
			stopping.reap("a"),
			stopping.reap("b"),
			stopping.reap("c"),
		]);
		expect(
			reported.map((error) =>
				error instanceof Error ? [error.message, String(error.cause)] : error,
			),
			"the failure, once, saying what failed",
		).toEqual([
			[
				"The start's one reading of the process table failed, so each reap reads it for itself",
				"Error: /proc refused",
			],
		]);
		expect(
			[...table.killed].sort((x, y) => x - y),
			"each found by its own reading",
		).toEqual([10, 20]);
		expect(
			table.listed,
			"the failed one, then each its own, and again after each kill",
		).toBe(6);
	});

	it("read it whole again for a conversation's second reap of the start, which pi has built since", async () => {
		const table = countingTable({ 1: {}, 10: conversationMarker("z", HOST) });
		const stopping = keeping(table);
		stopping.resuming(["a"]);
		await stopping.reap("a");
		expect(table.listed).toBe(1);
		await stopping.reap("a");
		expect(table.listed, "its own reading").toBe(2);
	});

	it("spare at the start's reap of the key what a child parked in its conversation's folder", async () => {
		// An earlier host under the key, gone: nothing runs as pid 99.
		const gone = { key: HOST.key, mark: "99:0" };
		const table = countingTable({
			1: {},
			10: { ...conversationMarker("a", gone), [CALL_VARIABLE]: "k1" },
			20: conversationMarker("b", gone),
		});
		const stopping = keeping(table);
		const stateDir = dirs.at(-1) ?? "";
		mkdirSync(join(stateDir, "a"));
		writeFileSync(
			join(stateDir, "a", LEFT_FILE),
			JSON.stringify([{ session: "a", mark: "k1", at: Date.now() }]),
		);
		await stopping.reapEarlier(HOST.key);
		expect(table.killed, "only what no park kept").toEqual([20]);
	});

	it("try the start's reap of the key again each tick while it waits, and no more once it doesn't", async () => {
		const gone = { key: HOST.key, mark: "99:0" };
		const table = countingTable({ 1: {}, 20: conversationMarker("b", gone) });
		const reported: unknown[] = [];
		const ticks: { ms: number; run: () => void; stopped: boolean }[] = [];
		const stopping = keeping(table, reported, [], (ms, run) => {
			const tick = { ms, run, stopped: false };
			ticks.push(tick);
			return () => {
				tick.stopped = true;
			};
		});
		listFault.folder = dirs.at(-1);
		await stopping.reapEarlier(HOST.key);
		expect(table.killed, "whom to spare is not known").toEqual([]);
		expect(ticks.map(({ ms }) => ms)).toEqual([STRAY_LOOK_MS]);
		const [tick] = ticks;
		if (tick === undefined) throw new Error("no retry was set");
		const waits = () =>
			reported.filter((said) => String(said).includes("ended nothing")).length;
		expect(waits()).toBe(1);
		tick.run();
		// The try runs off the tick: done once its wait is said.
		await vi.waitFor(() => expect(waits()).toBe(2));
		expect(table.killed, "still waiting").toEqual([]);
		expect(tick.stopped).toBe(false);
		listFault.folder = undefined;
		tick.run();
		await vi.waitFor(() =>
			expect(tick.stopped, "a try that didn't wait ends the retries").toBe(
				true,
			),
		);
		expect(table.killed, "once the folder lists").toEqual([20]);
		expect(waits(), "no wait more").toBe(2);
	});

	it("set no retry for a start's reap of the key that didn't wait", async () => {
		const table = countingTable({ 1: {} });
		const ticks: number[] = [];
		const stopping = keeping(table, [], [], (ms) => {
			ticks.push(ms);
			return () => undefined;
		});
		await stopping.reapEarlier(HOST.key);
		expect(ticks).toEqual([]);
	});

	it("spare at a conversation's own reap what a child parked in its conversation's folder", async () => {
		const table = countingTable({
			1: {},
			10: { ...conversationMarker("a", HOST), [CALL_VARIABLE]: "k1" },
			20: conversationMarker("a", HOST),
		});
		const stopping = keeping(table);
		const stateDir = dirs.at(-1) ?? "";
		mkdirSync(join(stateDir, "a"));
		writeFileSync(
			join(stateDir, "a", LEFT_FILE),
			JSON.stringify([{ session: "a", mark: "k1", at: Date.now() }]),
		);
		await stopping.reap("a");
		expect(table.killed, "only what no park kept").toEqual([20]);
	});

	it("read it for themselves outside a start", async () => {
		const table = countingTable({ 1: {}, 10: conversationMarker("z", HOST) });
		const stopping = keeping(table);
		await stopping.reap("a");
		await stopping.reap("b");
		expect(table.listed, "before the start").toBe(2);
		stopping.resuming(["c"]);
		stopping.resumed();
		await stopping.reap("c");
		expect(table.listed, "once it is over").toBe(3);
	});
});

// A carry ends its run, so its conversation reads as idle while it
// bundles; a host restart then would lose it (PV3TE0's F34, 23 November).
describe("what a host restart would end of a carry", () => {
	const carried = "01a1ecbb-0000-7000-8000-0000000ca44e";

	it("names a carry under way, and nothing once it lets go", () => {
		const hold = holdForCarry(carried, "penelope");
		try {
			expect(carryEnds(carried)).toEqual(["a carry to penelope"]);
			expect(carryEnds("another")).toEqual([]);
		} finally {
			hold.release();
		}
		expect(carryEnds(carried)).toEqual([]);
	});
});
