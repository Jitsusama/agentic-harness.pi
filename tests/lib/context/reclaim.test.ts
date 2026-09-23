import { describe, expect, it } from "vitest";
import { findReclaimable } from "../../../lib/context/index.js";

function bashResult(toolCallId: string, chars: number) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text: "x".repeat(chars) }],
	};
}

function readResult(toolCallId: string, chars: number) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: "x".repeat(chars) }],
	};
}

function userMessage() {
	return { role: "user" as const, content: [] };
}

describe("finding what a demotion policy could reclaim", () => {
	it("finds nothing when every bash result is inside the kept window", () => {
		const messages = [bashResult("t1", 1000), bashResult("t2", 1000)];
		const result = findReclaimable(messages, { keepRecent: 2 });
		expect(result.candidates).toEqual([]);
	});

	it("finds a bash result once it falls outside the kept window", () => {
		const messages = [
			bashResult("t1", 5000),
			bashResult("t2", 1000),
			bashResult("t3", 1000),
		];
		const result = findReclaimable(messages, { keepRecent: 2 });
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].toolCallId).toBe("t1");
		expect(result.totalChars).toBe(5000);
	});

	it("does not touch a tool outside its named set, by default anything but bash", () => {
		const messages = [
			readResult("t1", 90_000),
			bashResult("t2", 1000),
			bashResult("t3", 1000),
			bashResult("t4", 1000),
		];
		const result = findReclaimable(messages, { keepRecent: 2 });
		expect(result.candidates.every((c) => c.toolName === "bash")).toBe(true);
		expect(result.candidates.some((c) => c.toolCallId === "t1")).toBe(false);
	});

	it("returns candidates in their original chronological order", () => {
		// Chronological order is preserved deliberately: reordering resident
		// messages, even to group candidates, would break the provider's
		// own prompt cache, and this is meant to inform a rewrite that
		// respects that, not to produce a sorted report.
		const messages = [
			bashResult("t1", 2000),
			bashResult("t2", 3000),
			bashResult("t3", 1000),
			bashResult("t4", 1000),
		];
		const result = findReclaimable(messages, { keepRecent: 2 });
		expect(result.candidates.map((c) => c.toolCallId)).toEqual(["t1", "t2"]);
	});

	it("ignores a message with no content to measure", () => {
		const messages = [userMessage(), bashResult("t1", 1000)];
		const result = findReclaimable(messages, { keepRecent: 0 });
		expect(result.candidates).toHaveLength(1);
	});

	it("counts only bytes of the candidates, not the whole context", () => {
		const messages = [
			bashResult("t1", 4000),
			bashResult("t2", 6000),
			bashResult("t3", 1000),
		];
		const result = findReclaimable(messages, { keepRecent: 1 });
		expect(result.totalChars).toBe(10_000);
	});
});
