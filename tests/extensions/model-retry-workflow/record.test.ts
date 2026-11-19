/**
 * Reading a session's branch for the wait a reload or a restart cut
 * short, from the entries pi keeps: messages, the retry's own marks and
 * job-workflow's record of results it kept unsaid.
 */

import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	RETRY_ENTRY,
	TAKEN_UP_WITHIN_MS,
	TRY_LABEL,
	unfinishedWait,
} from "../../../extensions/model-retry-workflow/record.ts";
import {
	FIRST_WAIT_MS,
	LONGEST_WAIT_MS,
} from "../../../lib/internal/errors/model-failure.ts";

const RELAY_502 = "502 this relay's request to its origin failed";
const BAD_REQUEST = "400 invalid_request_error: the request is malformed";
const WINDOW = 200_000;
const NOW = 1_763_450_000_000;

function reply(
	stopReason: StopReason,
	errorMessage: string | undefined,
	timestamp: number,
): unknown {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp,
	};
	return { type: "message", message };
}

const failed = (timestamp = NOW) => reply("error", RELAY_502, timestamp);
const user = (content = "carry on") => ({
	type: "message",
	message: { role: "user", content },
});
const mark = (attempt: number, due?: number) => ({
	type: "custom",
	customType: RETRY_ENTRY,
	data: due === undefined ? { attempt } : { attempt, due },
});

describe("the wait a branch was left in", () => {
	it("is the pending try a mark after the failure names", () => {
		// 18 November on a later try: the third was due as the load ended.
		const due = NOW + 2 * FIRST_WAIT_MS;
		const wait = unfinishedWait(
			[
				failed(),
				mark(1),
				user(),
				failed(),
				mark(2),
				user(),
				failed(),
				mark(3, due),
			],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ attempt: 3, due, carried: false });
	});

	it("is due at the failure when its mark has no time", () => {
		const wait = unfinishedWait([failed(), mark(2)], WINDOW, NOW);
		expect(wait).toMatchObject({ attempt: 2, due: NOW });
	});

	it("is the try after the streak's last mark when none is pending", () => {
		const wait = unfinishedWait(
			[failed(), mark(1), user(), failed()],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ attempt: 2, due: NOW + 2 * FIRST_WAIT_MS });
	});

	it("starts afresh after a reply that was stopped", () => {
		const wait = unfinishedWait(
			[
				failed(),
				mark(4),
				user(),
				reply("aborted", undefined, NOW),
				user(),
				failed(),
			],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ attempt: 1 });
	});

	it("starts afresh after a failure no try gets past", () => {
		const wait = unfinishedWait(
			[
				failed(),
				mark(4),
				user(),
				reply("error", BAD_REQUEST, NOW),
				user(),
				failed(),
			],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ attempt: 1 });
	});

	it("is none once the person stopped it", () => {
		expect(unfinishedWait([failed(), mark(0)], WINDOW, NOW)).toBeUndefined();
	});

	it("is none when the branch ends on anything but a passing failure", () => {
		expect(unfinishedWait([failed(), user()], WINDOW, NOW)).toBeUndefined();
		expect(
			unfinishedWait([reply("error", BAD_REQUEST, NOW)], WINDOW, NOW),
		).toBeUndefined();
		expect(unfinishedWait([], WINDOW, NOW)).toBeUndefined();
	});

	it("is none when the pending try was due an hour ago", () => {
		const due = NOW - TAKEN_UP_WITHIN_MS - 1;
		expect(
			unfinishedWait([failed(due - FIRST_WAIT_MS), mark(2, due)], WINDOW, NOW),
		).toBeUndefined();
	});

	it("is none for a failure of no known age", () => {
		expect(unfinishedWait([failed(0)], WINDOW, NOW)).toBeUndefined();
		expect(unfinishedWait([failed(Number.NaN)], WINDOW, NOW)).toBeUndefined();
	});

	it("takes a failure stamped later than now as now", () => {
		const wait = unfinishedWait(
			[failed(NOW + TAKEN_UP_WITHIN_MS)],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ attempt: 1, due: NOW + FIRST_WAIT_MS });
	});

	it("is never further off than the longest wait", () => {
		const wait = unfinishedWait(
			[failed(), mark(2, NOW + 100 * LONGEST_WAIT_MS)],
			WINDOW,
			NOW,
		);
		expect(wait).toMatchObject({ due: NOW + LONGEST_WAIT_MS });
	});

	it("is carried when job-workflow kept its try unsaid", () => {
		const kept = {
			type: "custom",
			customType: "job-carried",
			data: {
				at: NOW,
				jobs: [],
				results: [{ jobId: "j1", label: TRY_LABEL, text: "try 1" }],
			},
		};
		const wait = unfinishedWait([failed(), mark(1, NOW), kept], WINDOW, NOW);
		expect(wait).toMatchObject({ attempt: 1, carried: true });
	});
});
