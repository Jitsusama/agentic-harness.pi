import { describe, expect, it } from "vitest";
import {
	compactionFailureNotice,
	compactionNotice,
} from "../../../extensions/compaction-workflow/notice.ts";

const FIRED = {
	fire: true,
	margin: 1.02,
	// pi prices per million tokens, so 1_210_000 price-tokens is $1.21.
	cost: 1_210_000,
	turnsToRepay: 38.4,
};

describe("telling the user why the session is compacting", () => {
	it("names the cost in dollars and the turns that earn it back", () => {
		expect(compactionNotice(265_000, FIRED)).toBe(
			"Compacting at 265k tokens: $1.21 to summarise, earned back after about 38 more turns at this size",
		);
	});

	it("does not print the ratio, which reads 1.0x every time it fires", () => {
		expect(compactionNotice(265_000, FIRED)).not.toMatch(/\dx\b/);
	});

	it("says so when this stretch is one of the logged experiments", () => {
		const draw = { threshold: 2, propensity: 0.05, explored: true };
		expect(compactionNotice(265_000, FIRED, draw)).toBe(
			"Compacting at 265k tokens: $1.21 to summarise, earned back after about 38 more turns at this size. " +
				"This stretch was drawn to compact once savings reach 2.00 times the cost rather than 1.41, as a logged experiment",
		);
	});

	it("says nothing more when the stretch takes the usual threshold", () => {
		const draw = { threshold: 1, propensity: 0.9, explored: false };
		expect(compactionNotice(265_000, FIRED, draw)).toBe(
			compactionNotice(265_000, FIRED),
		);
	});
});

describe("telling the user a compaction failed", () => {
	it("says the context was left alone, why, and when it will try again", () => {
		expect(compactionFailureNotice(new Error("Connection error."), 8)).toBe(
			"Compaction failed, so the context was left as it is: Connection error. It will try again in 8 turns",
		);
	});

	it("names the setting that fixes a summary cut off at the token cap", () => {
		const capped = new Error(
			"Summarization failed: generation hit the token cap and the summary is incomplete",
		);
		expect(compactionFailureNotice(capped, 16)).toBe(
			"Compaction failed, so the context was left as it is: Summarization failed: generation hit the token cap and the summary is incomplete. " +
				"It will try again in 16 turns. The summary needs more room than pi reserves for it: " +
				'set "compaction": { "reserveTokens": 64000 } in ~/.pi/agent/settings.json and run /reload',
		);
	});
});
