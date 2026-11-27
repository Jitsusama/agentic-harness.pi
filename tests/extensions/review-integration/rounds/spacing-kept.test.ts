/**
 * The start spacing a waiting round reads at each look keeps its last
 * good value while the config can't be read, so a file caught half-saved
 * takes no waiting round to the quickest pace.
 */

import { describe, expect, it } from "vitest";
import { spacingKeptAcrossFailedReads } from "../../../../extensions/review-integration/tools/ask-round.ts";

/** A reader answering each of `reads` in turn, undefined for a failed read. */
function readsOf(reads: ({ ms: number | undefined } | undefined)[]) {
	let at = 0;
	return async () => {
		const read = reads[at];
		at += 1;
		return read;
	};
}

describe("the spacing a waiting round reads", () => {
	it("keeps the last good spacing through a failed read", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([{ ms: 180_000 }, undefined, { ms: 60_000 }]),
		);

		expect(await spacing()).toBe(180_000);
		expect(await spacing(), "the read failed").toBe(180_000);
		expect(await spacing()).toBe(60_000);
	});

	it("takes a spacing taken out of the config as none", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([{ ms: 180_000 }, { ms: undefined }]),
		);

		await spacing();

		expect(await spacing()).toBeUndefined();
	});

	it("says none when its first read fails", async () => {
		const spacing = spacingKeptAcrossFailedReads(readsOf([undefined]));

		expect(await spacing()).toBeUndefined();
	});
});
