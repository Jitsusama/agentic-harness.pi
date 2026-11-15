/**
 * Looking ids up a batch at a time: never more at once than Slack's
 * rate tiers take, and no further batch once the caller gives up.
 */

import { describe, expect, it } from "vitest";
import { inBatches } from "../../../../lib/slack/api/batches.ts";

const ids = (count: number) =>
	Array.from({ length: count }, (_, at) => `U${at}`);

describe("looking ids up in batches", () => {
	it("looks every id up, twenty at most at once", async () => {
		const seen: string[] = [];
		let running = 0;
		let most = 0;

		const finished = await inBatches(ids(45), async (id) => {
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setImmediate(resolve));
			seen.push(id);
			running--;
		});

		expect(finished, "every batch ran, so it says it finished").toBe(true);
		expect(seen.sort()).toEqual(ids(45).sort());
		expect(most).toBe(20);
	});

	it("starts no batch once its signal fires, and says it stopped", async () => {
		const stop = new AbortController();
		const seen: string[] = [];

		const finished = await inBatches(
			ids(45),
			async (id) => {
				seen.push(id);
				stop.abort();
			},
			stop.signal,
		);

		expect(finished, "the signal stopped it, so it says it didn't finish").toBe(
			false,
		);
		expect(seen).toHaveLength(20);
	});
});
