import { describe, expect, it } from "vitest";
import {
	compactionFailureNotice,
	compactionNotice,
	idleCompactionNotice,
} from "../../../extensions/compaction-workflow/notice.ts";

const FIRED = {
	fire: true,
	rentPaid: 0.6349,
	cost: { summary: 0.2161, rewrite: 0.3421, refetch: 0.0712, total: 0.6294 },
};

describe("telling the user why the session is compacting", () => {
	it("says the summary is being written in the background, what compacting costs, and what the dropped context has cost", () => {
		expect(compactionNotice(265_000, FIRED, { ahead: true })).toBe(
			"Writing a compaction summary in the background at 265k tokens. " +
				"Compacting costs about $0.63 (summary $0.22, rewrite $0.34, re-fetching $0.07), " +
				"and what it drops has cost $0.63 in reads since the last compaction",
		);
	});

	it("says why a compaction has to be written now, while the session waits", () => {
		expect(
			compactionNotice(265_000, FIRED, {
				ahead: false,
				reason: "nothing has been sent this session",
			}),
		).toBe(
			"Compacting at 265k tokens now, since the summary could not be written in the background: " +
				"nothing has been sent this session. " +
				"Compacting costs about $0.63 (summary $0.22, rewrite $0.34, re-fetching $0.07), " +
				"and what it drops has cost $0.63 in reads since the last compaction",
		);
	});

	it("says an idle session is compacted before its cache expires, and what that saves", () => {
		expect(idleCompactionNotice(280_000, 1.2, FIRED.cost)).toBe(
			"Compacting at 280k tokens while idle, before the cache expires: " +
				"coming back would rewrite $1.20 of context, and compacting now costs about $0.29",
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
