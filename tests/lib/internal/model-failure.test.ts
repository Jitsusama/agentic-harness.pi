import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	FIRST_WAIT_MS,
	failedForAMoment,
	failureLine,
	LONGEST_WAIT_MS,
	lastReply,
	MOST_TRIES,
	waitBefore,
} from "../../../lib/internal/model-failure.ts";

const WINDOW = 200_000;

function reply(
	stopReason: StopReason,
	errorMessage?: string,
): AssistantMessage {
	return {
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
		timestamp: 0,
	};
}

describe("a reply that failed for a moment", () => {
	it.each([
		["a timeout", "Request timed out."],
		["a server error", "500 Internal Server Error"],
		["an overloaded provider", '{"type":"overloaded_error"}'],
	])("is %s", (_, error) => {
		expect(failedForAMoment(reply("error", error), WINDOW)).toBe(true);
	});

	it("is never a reply that finished", () => {
		expect(failedForAMoment(reply("stop"), WINDOW)).toBe(false);
	});

	it("is never a reply somebody stopped", () => {
		expect(
			failedForAMoment(reply("aborted", "Request timed out."), WINDOW),
		).toBe(false);
	});

	it("is never a request the provider refused as malformed", () => {
		expect(
			failedForAMoment(reply("error", "400 invalid_request_error"), WINDOW),
		).toBe(false);
	});

	it("is never a context too long for the model", () => {
		expect(
			failedForAMoment(
				reply("error", "prompt is too long: 250000 tokens > 200000 maximum"),
				WINDOW,
			),
		).toBe(false);
	});
});

describe("the wait before each try", () => {
	it("starts at the first wait and doubles", () => {
		expect(waitBefore(1)).toBe(FIRST_WAIT_MS);
		expect(waitBefore(2)).toBe(2 * FIRST_WAIT_MS);
		expect(waitBefore(3)).toBe(4 * FIRST_WAIT_MS);
	});

	it("never passes the longest wait", () => {
		expect(waitBefore(MOST_TRIES)).toBe(LONGEST_WAIT_MS);
	});

	it("ends once the tries are spent", () => {
		expect(waitBefore(MOST_TRIES + 1)).toBeUndefined();
		expect(waitBefore(0)).toBeUndefined();
	});
});

describe("the last reply of a run", () => {
	it("is the last assistant message, past any tool results", () => {
		const failed = reply("error", "Request timed out.");
		const messages = [
			reply("toolUse"),
			failed,
			{ role: "toolResult", content: [] },
		];
		expect(lastReply(messages)).toBe(failed);
	});

	it("is absent when the run has none", () => {
		expect(lastReply([{ role: "user", content: "hi" }])).toBeUndefined();
	});
});

describe("the line a failure is told in", () => {
	it("is the first line of its message", () => {
		expect(failureLine(reply("error", "Request timed out.\nat stream"))).toBe(
			"Request timed out.",
		);
	});

	it("is cut to a notice's length", () => {
		const line = failureLine(reply("error", "x".repeat(300)));
		expect(line.length).toBe(100);
		expect(line.endsWith("...")).toBe(true);
	});

	it("says the call failed when the message is empty", () => {
		expect(failureLine(reply("error", ""))).toBe("the model call failed");
	});
});
