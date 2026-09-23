import { describe, expect, it } from "vitest";
import { readTurns } from "../../../lib/ledger/index.ts";

function assistant(
	id: string,
	calls: Array<{ id: string; name: string; args: unknown }>,
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: "2026-09-21T17:55:00.000Z",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 1, output: 1, cost: { total: 0.1 } },
			content: calls.map((c) => ({
				type: "toolCall",
				id: c.id,
				name: c.name,
				arguments: c.args,
			})),
		},
	});
}

function result(callId: string, text: string, isError = false): string {
	return JSON.stringify({
		id: `r-${callId}`,
		type: "message",
		timestamp: "2026-09-21T17:55:01.000Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			isError,
			content: [{ type: "text", text }],
		},
	});
}

describe("tool calls in a scan", () => {
	it("records one call per tool call, addressed by its arguments", () => {
		const scan = readTurns("s1", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "ls" } }]),
			result("t1", "a\nb\n"),
		]);

		expect(scan.calls).toHaveLength(1);
		const call = scan.calls[0];
		expect(call.name).toBe("bash");
		expect(call.sessionId).toBe("s1");
		expect(call.entryId).toBe("a1");
		expect(call.argsDigest).toMatch(/^[0-9a-f]{24}$/);
	});

	it("keeps no argument or result bytes, only their digests and size", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				{ id: "t1", name: "bash", args: { command: "grep secret /etc/x" } },
			]),
			result("t1", "SECRET-VALUE"),
		]);

		expect(JSON.stringify(scan.calls)).not.toContain("secret");
		expect(JSON.stringify(scan.calls)).not.toContain("SECRET-VALUE");
		expect(scan.calls[0].resultChars).toBe("SECRET-VALUE".length);
		expect(scan.calls[0].resultDigest).toMatch(/^[0-9a-f]{24}$/);
	});

	it("digests identical arguments alike, which is what makes a repeat visible", () => {
		// Duplicate tool calls by argument digest are provable waste: the
		// answer was already in the context when the call was made.
		const scan = readTurns("s1", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "ls" } }]),
			assistant("a2", [{ id: "t2", name: "bash", args: { command: "ls" } }]),
			assistant("a3", [{ id: "t3", name: "bash", args: { command: "pwd" } }]),
		]);

		expect(scan.calls[0].argsDigest).toBe(scan.calls[1].argsDigest);
		expect(scan.calls[0].argsDigest).not.toBe(scan.calls[2].argsDigest);
	});

	it("does not confuse the same arguments to different tools", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				{ id: "t1", name: "read", args: { path: "/x" } },
				{ id: "t2", name: "write", args: { path: "/x" } },
			]),
		]);

		expect(scan.calls[0].argsDigest).not.toBe(scan.calls[1].argsDigest);
	});

	it("records the file a call declared, and nothing for one that declared none", () => {
		// read, edit and write name their path. bash does not, and is the
		// largest tool by far, so file acquisition through it stays
		// invisible here rather than being guessed at from a command line.
		const scan = readTurns("s1", [
			assistant("a1", [
				{ id: "t1", name: "read", args: { path: "/src/a.ts" } },
				{ id: "t2", name: "bash", args: { command: "cat /src/b.ts" } },
			]),
		]);

		expect(scan.calls[0].path).toBe("/src/a.ts");
		expect(scan.calls[1].path).toBeNull();
	});

	it("marks a call whose result came back an error", () => {
		const scan = readTurns("s1", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "false" } }]),
			result("t1", "exit 1", true),
		]);

		expect(scan.calls[0].isError).toBe(true);
	});

	it("keeps a call whose result never arrived, saying the result is unknown", () => {
		// A run killed mid-call leaves the call without its result. The
		// call still happened, and a zero-length result would claim it
		// came back empty.
		const scan = readTurns("s1", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "sleep" } }]),
		]);

		expect(scan.calls).toHaveLength(1);
		expect(scan.calls[0].resultChars).toBeNull();
		expect(scan.calls[0].resultDigest).toBeNull();
	});

	it("addresses a call so the same call in a forked log collapses", () => {
		const first = readTurns("s1", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "ls" } }]),
		]);
		const forked = readTurns("s2", [
			assistant("a1", [{ id: "t1", name: "bash", args: { command: "ls" } }]),
		]);

		expect(first.calls[0].digest).toBe(forked.calls[0].digest);
	});
});
