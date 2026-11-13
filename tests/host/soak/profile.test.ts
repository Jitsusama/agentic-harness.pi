/**
 * Where a soak's CPU profiles say the time went: each sample given the
 * gap to the next, idle kept apart from busy, and the busy time summed
 * by area and by function across every profile read.
 */
import { describe, expect, it } from "vitest";
import { timeSpent } from "./profile.ts";

const PI = "file:///nix/store/x/lib/node_modules/pi-monorepo/node_modules";

/** A profile node at `url` named `name`. */
function node(id: number, name: string, url = "", line = 0): object {
	return {
		id,
		callFrame: { functionName: name, url, lineNumber: line },
		hitCount: 0,
	};
}

/** A profile whose samples land on `samples`, a ms apart in µs. */
function profile(samples: readonly number[]): object {
	return {
		nodes: [
			node(1, "(root)"),
			node(2, "(idle)"),
			node(3, "doRender", `${PI}/@earendil-works/pi-tui/dist/tui.js`, 41),
			node(4, "prompt", `${PI}/@earendil-works/pi-agent-core/dist/agent.js`),
			node(5, "onTurn", "file:///w/h/extensions/job-workflow/index.ts"),
			node(6, "(garbage collector)"),
			node(
				7,
				"parse",
				"file:///w/h/node_modules/.pnpm/a/node_modules/x/lib/y.js",
			),
		],
		samples,
		timeDeltas: samples.map(() => 1000),
	};
}

describe("where a profile's time went", () => {
	it("sums busy time by area, the busiest first, idle apart", () => {
		const spent = timeSpent([profile([3, 3, 3, 2, 2, 4, 5, 6, 7])]);
		expect(spent.idleMs, "two idle samples").toBe(2);
		expect(spent.busyMs, "seven busy samples").toBe(7);
		expect(spent.areas, "by area").toEqual([
			{ name: "screen: pi-tui", ms: 3 },
			{ name: "pi: pi-agent-core", ms: 1 },
			{ name: "extension: job-workflow", ms: 1 },
			{ name: "garbage collection", ms: 1 },
			{ name: "package: x", ms: 1 },
		]);
	});

	it("names each busy function with its script and line", () => {
		const [first] = timeSpent([profile([3, 3, 4])]).functions;
		expect(first, "the render, twice").toEqual({
			name: "doRender pi-tui/dist/tui.js:42",
			ms: 2,
		});
	});

	it("gives node's work to the nearest caller of the harness's or pi's", () => {
		const called = {
			nodes: [
				{ ...node(1, "onTurn", "file:///w/h/extensions/job-workflow/i.ts", 9), children: [2] },
				{ ...node(2, "execFileSync", "node:child_process"), children: [3] },
				node(3, "spawnSync", "node:internal/child_process"),
				node(4, "(garbage collector)"),
			],
			samples: [3, 3, 1, 4],
			timeDeltas: [1000, 1000, 1000, 1000],
		};
		expect(timeSpent([called]).calledFrom, "the sync spawn, not the GC").toEqual([
			{ name: "onTurn extensions/job-workflow/i.ts:10", ms: 2 },
		]);
	});

	it("adds several profiles together and skips what isn't one", () => {
		const spent = timeSpent([profile([3]), profile([3]), "nonsense", {}]);
		expect(spent.profiles, "two read").toBe(2);
		expect(spent.areas, "both renders").toEqual([
			{ name: "screen: pi-tui", ms: 2 },
		]);
	});
});
