/**
 * What a start's reaps read: between resuming and resumed, the table is
 * read once for the first reap of every conversation the start holds,
 * and every other reap (a held one's second, one the start doesn't hold,
 * one after a failed reading, or any outside a start) reads it whole.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEFT_FILE } from "../../../host/engine/left-running.ts";
import { stopKeeping } from "../../../host/engine/stopping.ts";
import {
	conversationMarker,
	type ProcessTable,
} from "../../../host/engine/tool-children.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";

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
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
	});
	function keeping(
		table: ProcessTable,
		reported: unknown[] = [],
		kept: readonly { session: string; mark: string }[] = [],
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
