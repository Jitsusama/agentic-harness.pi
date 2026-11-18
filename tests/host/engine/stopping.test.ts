/**
 * What a start's reaps read: between resuming and resumed, the table is
 * read once for every conversation's first reap, and each reap after a
 * conversation's first, or outside a start, reads it whole again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopKeeping } from "../../../host/engine/stopping.ts";
import {
	conversationMarker,
	type ProcessTable,
} from "../../../host/engine/tool-children.ts";

/** The host the table's processes ran under: pid 1, started at tick 0. */
const HOST = { key: "test-host", mark: "1:0" };

/** A table of marked processes that counts how often it is listed whole. */
function countingTable(
	envs: Record<number, Record<string, string>>,
): ProcessTable & { listed: number; killed: number[] } {
	const live = new Map(
		Object.entries(envs).map(([pid, env]) => [Number(pid), env]),
	);
	const table = {
		self: 1,
		listed: 0,
		killed: [] as number[],
		pids: () => {
			table.listed += 1;
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
	function keeping(table: ProcessTable) {
		const stateDir = mkdtempSync(join(tmpdir(), "stopping-"));
		dirs.push(stateDir);
		return stopKeeping({ stateDir, report: () => undefined, table });
	}

	it("read the table once for every conversation's first reap", async () => {
		const table = countingTable({
			1: {},
			10: conversationMarker("z", HOST),
			30: {},
		});
		const stopping = keeping(table);
		stopping.resuming();
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
		stopping.resuming();
		await stopping.reap("a");
		await stopping.reap("b");
		expect(table.killed).toEqual([10, 20]);
	});

	it("read it whole again for a conversation's second reap of the start, which pi has built since", async () => {
		const table = countingTable({ 1: {}, 10: conversationMarker("z", HOST) });
		const stopping = keeping(table);
		stopping.resuming();
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
		stopping.resuming();
		stopping.resumed();
		await stopping.reap("c");
		expect(table.listed, "once it is over").toBe(3);
	});
});
