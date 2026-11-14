/**
 * What one plain pi a conversation costs: how long each took from its
 * start to answering, all started at once, and what each weighed then
 * and once its turns were done, read from the kernel's rollup of its
 * mappings.
 */
import { describe, expect, it } from "vitest";
import { plainProcessesOf, rollupOf } from "./processes.ts";

/** A kernel rollup, cut to the lines read and one around them. */
const ROLLUP = [
	"55d0c0000000-7ffd0000000 ---p 00000000 00:00 0  [rollup]",
	"Rss:              412340 kB",
	"Pss:              301122 kB",
	"Pss_Anon:         250000 kB",
	"Shared_Clean:      90000 kB",
].join("\n");

describe("one plain pi a conversation", () => {
	it("reads a process's Pss and Rss from its rollup", () => {
		expect(rollupOf(ROLLUP), "both read").toEqual({
			pssKb: 301_122,
			rssKb: 412_340,
		});
		expect(rollupOf("Rss: 10 kB\n"), "no Pss").toBeUndefined();
		expect(rollupOf(""), "nothing").toBeUndefined();
	});

	it("spreads each process's start and weight, counting those unread", () => {
		expect(
			plainProcessesOf([
				{
					readyMs: 900,
					ready: { pssKb: 200, rssKb: 300 },
					done: { pssKb: 400, rssKb: 500 },
				},
				{ readyMs: 1_500, ready: { pssKb: 220, rssKb: 330 } },
				{ readyMs: 1_200 },
			]),
			"three started at once, one never weighed and one unread once done",
		).toEqual({
			started: 3,
			readyMs: { count: 3, p50: 1_200, p99: 1_500, max: 1_500 },
			pssReadyKb: { count: 2, p50: 200, p99: 220, max: 220 },
			rssReadyKb: { count: 2, p50: 300, p99: 330, max: 330 },
			pssDoneKb: { count: 1, p50: 400, p99: 400, max: 400 },
			rssDoneKb: { count: 1, p50: 500, p99: 500, max: 500 },
			unread: 3,
		});
	});
});
