import { describe, expect, it } from "vitest";
import { headWatch } from "../../../../lib/internal/install/head.ts";

const INTERVAL = 600_000;

function watching(heads: Array<string | undefined>, loaded = "aaa") {
	let time = 0;
	let reads = 0;
	const watch = headWatch({
		loaded: Promise.resolve(loaded),
		read: async () => {
			reads += 1;
			return heads.shift();
		},
		intervalMs: INTERVAL,
		now: () => time,
	});
	return {
		watch,
		advance: (ms: number) => {
			time += ms;
		},
		reads: () => reads,
	};
}

describe("a checkout's HEAD against the one it loaded from", () => {
	it("says nothing while HEAD has not moved", async () => {
		const { watch } = watching(["aaa"]);
		expect(await watch.check()).toBeUndefined();
	});

	it("says a move once, and again only for a newer one", async () => {
		const { watch, advance } = watching(["bbb", "bbb", "ccc"]);
		expect(await watch.check()).toEqual({ loaded: "aaa", now: "bbb" });
		advance(INTERVAL);
		expect(await watch.check()).toBeUndefined();
		advance(INTERVAL);
		expect(await watch.check()).toEqual({ loaded: "aaa", now: "ccc" });
	});

	it("reads at most once an interval", async () => {
		const { watch, advance, reads } = watching(["aaa", "bbb"]);
		await watch.check();
		advance(INTERVAL - 1);
		expect(await watch.check()).toBeUndefined();
		expect(reads()).toBe(1);
	});

	it("does nothing without git", async () => {
		const watch = headWatch({
			loaded: Promise.resolve(undefined),
			read: async () => "bbb",
			intervalMs: INTERVAL,
		});
		expect(await watch.check()).toBeUndefined();
	});
});
