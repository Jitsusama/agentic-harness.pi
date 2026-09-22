import { describe, expect, it } from "vitest";
import { digestEvents } from "../../../lib/subagent/digest.js";

const USAGE = {
	input: 4,
	output: 224,
	cacheRead: 1000,
	cacheWrite: 5000,
	totalTokens: 6228,
	cost: {
		input: 0,
		output: 0.0056,
		cacheRead: 0.0005,
		cacheWrite: 0.03,
		total: 0.0361,
	},
};

const lines = (...events: object[]) => events.map((e) => JSON.stringify(e));

const session = {
	type: "session",
	id: "s-1",
	timestamp: "2026-09-18T18:22:18Z",
	cwd: "/w",
};
const assistant = (text: string, calls: object[] = []) => ({
	type: "message_end",
	message: {
		role: "assistant",
		model: "claude-opus-5",
		usage: USAGE,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: 1,
		content: [{ type: "text", text }, ...calls],
	},
});
const toolResult = (id: string, text: string) => ({
	type: "message_end",
	message: {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		isError: false,
		timestamp: 2,
		content: [{ type: "text", text }],
	},
});
const call = (id: string, command: string) => ({
	type: "toolCall",
	id,
	name: "bash",
	arguments: { command },
});

describe("digestEvents", () => {
	it("keeps every assistant turn's usage exactly as the provider reported it", () => {
		// Usage is kept verbatim rather than recomputed, so a figure can
		// always be traced back to what was actually billed.
		const { records } = digestEvents(lines(session, assistant("done")));
		const turn = records.find((r) => r.kind === "assistant");

		expect(turn?.usage).toEqual(USAGE);
		expect(turn?.model).toBe("claude-opus-5");
	});

	it("names each tool call with a digest of its arguments, not the arguments", () => {
		const { records } = digestEvents(
			lines(assistant("", [call("t1", "ls -la /very/long/path")])),
		);
		const turn = records.find((r) => r.kind === "assistant");

		expect(turn?.toolCalls).toHaveLength(1);
		expect(turn?.toolCalls?.[0].name).toBe("bash");
		expect(turn?.toolCalls?.[0].argsDigest).toMatch(/^[0-9a-f]{24}$/);
		expect(JSON.stringify(records)).not.toContain("/very/long/path");
	});

	it("gives identical arguments the same digest, so repetition is visible", () => {
		const { records } = digestEvents(
			lines(
				assistant("", [call("t1", "cat x")]),
				assistant("", [call("t2", "cat x")]),
				assistant("", [call("t3", "cat y")]),
			),
		);
		const digests = records
			.filter((r) => r.kind === "assistant")
			.map((r) => r.toolCalls?.[0].argsDigest);

		expect(digests[0]).toBe(digests[1]);
		expect(digests[0]).not.toBe(digests[2]);
	});

	it("records a tool result's size and digest but not its bytes", () => {
		const big = "x".repeat(50_000);
		const { records } = digestEvents(lines(toolResult("t1", big)));
		const result = records.find((r) => r.kind === "toolResult");

		expect(result?.chars).toBe(50_000);
		expect(result?.digest).toMatch(/^[0-9a-f]{24}$/);
		expect(result?.toolCallId).toBe("t1");
		expect(JSON.stringify(records).length).toBeLessThan(1000);
	});

	it("marks the final answer, which is what the parent received", () => {
		// The one class-A waste test available for fleets is whether the
		// parent ever used what came back. That needs to know which text
		// came back, long after the transcript itself is gone.
		const { records, answer } = digestEvents(
			lines(
				assistant("thinking", [call("t1", "ls")]),
				toolResult("t1", "a"),
				assistant("final answer"),
			),
		);

		expect(answer?.chars).toBe("final answer".length);
		expect(answer?.digest).toBe(
			records.filter((r) => r.kind === "assistant").at(-1)?.digest,
		);
	});

	it("drops streaming deltas, which are the bulk of the stream and restate the end", () => {
		const { records } = digestEvents(
			lines(
				{ type: "message_update", message: { role: "assistant" } },
				{ type: "tool_execution_update" },
				assistant("x"),
			),
		);

		expect(records.map((r) => r.kind)).toEqual(["assistant"]);
	});

	it("counts a line it cannot read and carries on", () => {
		const { records, coverage } = digestEvents([
			JSON.stringify(assistant("a")),
			"{truncated",
			JSON.stringify(assistant("b")),
		]);

		expect(records).toHaveLength(2);
		expect(coverage.lines).toBe(3);
		expect(coverage.unparseable).toBe(1);
	});

	it("keeps the session's identity and directory", () => {
		const { records } = digestEvents(lines(session));

		expect(records[0]).toMatchObject({ kind: "session", id: "s-1", cwd: "/w" });
	});
});
