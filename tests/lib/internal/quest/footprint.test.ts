import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	duMeasure,
	leftBehindOf,
	type Measure,
	measureEach,
	measureHoldings,
	ownOf,
	readDu,
	reclaimableOf,
	type Size,
} from "../../../../lib/internal/quest/footprint.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "footprint-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A directory under the test root, made. */
function dir(...parts: string[]): string {
	const path = join(root, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
}

/** A measure that answers a fixed size for every path it is asked. */
function fixed(sizes: Record<string, number>): {
	measure: Measure;
	asked: string[];
} {
	const asked: string[] = [];
	return {
		asked,
		measure: async (path) => {
			asked.push(path);
			const bytes = sizes[path];
			return bytes === undefined ? undefined : { bytes, complete: true };
		},
	};
}

describe("readDu", () => {
	it("takes the line naming the path as its total", () => {
		expect(readDu("4\t/w/a\n10\t/w\n", "/w")).toEqual({
			bytes: 10 * 1024,
			complete: true,
		});
	});

	it("is a lower bound from the finished subfolders when cut short", () => {
		expect(readDu("4\t/w/a\n6\t/w/b\n", "/w")).toEqual({
			bytes: 10 * 1024,
			complete: false,
		});
	});
});

describe("duMeasure", () => {
	it("measures a real directory at the lowest priority", async () => {
		const path = dir("ws");
		writeFileSync(join(path, "data"), Buffer.alloc(200 * 1024));
		const size = await duMeasure()(path);
		expect(size?.complete).toBe(true);
		expect(size?.bytes).toBeGreaterThanOrEqual(200 * 1024);
	});

	it("says a missing path is not there", async () => {
		expect(await duMeasure()(join(root, "gone"))).toBeUndefined();
	});

	it("gives each walk what is left of one deadline, then measures nothing", async () => {
		let clock = 0;
		const clocks: number[] = [];
		const exec = (timeoutMs: number): Exec => {
			clocks.push(timeoutMs);
			return async () => {
				clock += 700;
				return { code: 0, stdout: "", stderr: "" };
			};
		};
		const measure = duMeasure({ deadlineMs: 1000, now: () => clock, exec });
		const path = dir("ws");
		await measure(path);
		await measure(path);
		const late = await measure(path);
		expect(clocks).toEqual([1000, 300]);
		expect(late).toEqual({ bytes: 0, complete: false });
	});

	it("measures nothing once the report is stopped", async () => {
		const stop = new AbortController();
		stop.abort();
		const size = await duMeasure({ signal: stop.signal })(dir("ws"));
		expect(size).toEqual({ bytes: 0, complete: false });
	});
});

describe("measureEach", () => {
	it("sizes each path one at a time and leaves out the missing", async () => {
		const here = dir("here");
		const { measure, asked } = fixed({ [here]: 4 });
		const gone = join(root, "gone");
		const sizes = await measureEach([here, gone], measure);
		expect(asked).toEqual([here, gone]);
		expect([...sizes]).toEqual([[here, { bytes: 4, complete: true }]]);
	});
});

describe("measureHoldings", () => {
	it("counts a finished quest's workspace as reclaimable, and the trees it left for a prune", async () => {
		const workspaces = dir("workspaces");
		const ws = dir("workspaces", "Q1");
		const made = dir("trees", "q1");
		const { measure } = fixed({ [ws]: 5, [made]: 7 });
		const { quests } = await measureHoldings(
			[
				{
					id: "Q1",
					status: "concluded",
					trees: [{ path: made, origin: "scaffolded" }],
				},
			],
			workspaces,
			measure,
		);
		expect(ownOf(quests[0])).toEqual({ bytes: 12, complete: true });
		expect(reclaimableOf(quests[0]).bytes).toBe(5);
		expect(leftBehindOf(quests[0]).bytes).toBe(7);
	});

	it("holds everything a quest under way made", async () => {
		const workspaces = dir("workspaces");
		const ws = dir("workspaces", "Q1");
		const { measure } = fixed({ [ws]: 5 });
		const { quests } = await measureHoldings(
			[{ id: "Q1", status: "active", trees: [] }],
			workspaces,
			measure,
		);
		expect(reclaimableOf(quests[0]).bytes).toBe(0);
		expect(leftBehindOf(quests[0]).bytes).toBe(0);
	});

	it("measures an adopted tree once however many quests adopted it, and frees none of it", async () => {
		const workspaces = dir("workspaces");
		const shared = dir("checkout");
		const { measure, asked } = fixed({ [shared]: 9 });
		const tree = { path: shared, origin: "adopted" as const };
		const holdings = await measureHoldings(
			[
				{ id: "Q1", status: "concluded", trees: [tree] },
				{ id: "Q2", status: "active", trees: [tree] },
			],
			workspaces,
			measure,
		);
		expect(asked.filter((p) => p === shared)).toHaveLength(1);
		expect(holdings.adopted).toEqual([
			{
				path: shared,
				size: { bytes: 9, complete: true },
				quests: ["Q1", "Q2"],
			},
		]);
		expect(reclaimableOf(holdings.quests[0]).bytes).toBe(0);
	});

	it("does not count a tree cut inside a workspace twice", async () => {
		const workspaces = dir("workspaces");
		const ws = dir("workspaces", "Q1");
		const inner = dir("workspaces", "Q1", "clone", ".worktrees", "q1");
		const { measure, asked } = fixed({ [ws]: 5, [inner]: 3 });
		const { quests } = await measureHoldings(
			[
				{
					id: "Q1",
					status: "active",
					trees: [{ path: inner, origin: "scaffolded" }],
				},
			],
			workspaces,
			measure,
		);
		expect(asked).not.toContain(inner);
		expect(ownOf(quests[0]).bytes).toBe(5);
	});

	it("leaves out quests holding nothing on disk", async () => {
		const { measure } = fixed({});
		const holdings = await measureHoldings(
			[
				{
					id: "Q1",
					status: "concluded",
					trees: [{ path: join(root, "pruned"), origin: "scaffolded" }],
				},
			],
			dir("workspaces"),
			measure,
		);
		expect(holdings.quests).toEqual([]);
	});

	it("stays a lower bound when any part of it is one", async () => {
		const workspaces = dir("workspaces");
		const ws = dir("workspaces", "Q1");
		const made = dir("trees", "q1");
		const sizes: Record<string, Size> = {
			[ws]: { bytes: 5, complete: true },
			[made]: { bytes: 2, complete: false },
		};
		const { quests } = await measureHoldings(
			[
				{
					id: "Q1",
					status: "retired",
					trees: [{ path: made, origin: "scaffolded" }],
				},
			],
			workspaces,
			async (path) => sizes[path],
		);
		expect(ownOf(quests[0])).toEqual({ bytes: 7, complete: false });
		expect(leftBehindOf(quests[0])).toEqual({ bytes: 2, complete: false });
	});
});
