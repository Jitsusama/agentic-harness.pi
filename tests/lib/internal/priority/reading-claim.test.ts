/**
 * The claim on reading the machine for a keep: one session reads while
 * the others leave it, so a keep costs one reading rather than one a
 * session.
 */

import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimReading,
	READING_CLAIM_MS,
} from "../../../../lib/internal/priority/reading-claim.ts";

const NOW = Date.parse("2026-11-12T09:00:00Z");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reading-claim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the claim on reading the machine", () => {
	it("gives the reading to one session while it holds the claim", () => {
		const first = claimReading(dir, NOW);
		const second = claimReading(dir, NOW + 1);

		expect(
			[first !== undefined, second !== undefined],
			"the first session claims it, the second leaves it",
		).toEqual([true, false]);
	});

	it("lets the next session read once the claim is given back", () => {
		const first = claimReading(dir, NOW);
		first?.();

		expect(
			claimReading(dir, NOW + 1),
			"a claim given back is taken again",
		).toBeDefined();
	});

	it("takes over a claim left by a session that died reading", () => {
		claimReading(dir, NOW);
		const claim = join(dir, "locks", "reading");
		const left = (NOW - READING_CLAIM_MS) / 1000;
		utimesSync(claim, left, left);

		expect(
			claimReading(dir, NOW),
			`a claim ${READING_CLAIM_MS} ms old is taken over`,
		).toBeDefined();
	});
});
