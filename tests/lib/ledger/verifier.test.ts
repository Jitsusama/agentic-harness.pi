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

function bash(
	callId: string,
	command: string,
): {
	id: string;
	name: string;
	args: unknown;
} {
	return { id: callId, name: "bash", args: { command } };
}

describe("verifier classification", () => {
	it("classifies real test invocations across languages", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				bash("t1", "go test ./..."),
				bash("t2", "pnpm test"),
				bash("t3", "npx vitest run"),
				bash("t4", "pytest tests/"),
			]),
		]);

		for (const call of scan.calls) expect(call.verifierKind).toBe("test");
	});

	it("classifies build invocations", () => {
		const scan = readTurns("s1", [
			assistant("a1", [bash("t1", "go build ./..."), bash("t2", "pnpm build")]),
		]);

		for (const call of scan.calls) expect(call.verifierKind).toBe("build");
	});

	it("classifies typecheck invocations", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				bash("t1", "npx tsc --noEmit"),
				bash("t2", "pnpm typecheck"),
			]),
		]);

		for (const call of scan.calls) expect(call.verifierKind).toBe("typecheck");
	});

	it("classifies lint invocations", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				bash("t1", "npm run lint"),
				bash("t2", "golangci-lint run"),
				bash("t3", "npx biome check ."),
			]),
		]);

		for (const call of scan.calls) expect(call.verifierKind).toBe("lint");
	});

	it("classifies a chained gate that runs more than one kind as verify", () => {
		// This project's own gate is exactly this shape: lint, then
		// typecheck, then test, chained with &&, one exit code for the
		// whole thing. Picking a single one of the three would claim a
		// precision the one exit code cannot support.
		const scan = readTurns("s1", [
			assistant("a1", [
				bash("t1", "pnpm run lint && pnpm run typecheck && pnpm run test"),
			]),
		]);

		expect(scan.calls[0].verifierKind).toBe("verify");
	});

	it("leaves an ordinary command unclassified", () => {
		const scan = readTurns("s1", [
			assistant("a1", [bash("t1", "ls -la"), bash("t2", "cat package.json")]),
		]);

		for (const call of scan.calls) expect(call.verifierKind).toBeNull();
	});

	it("does not classify a non-bash tool by its arguments", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				{ id: "t1", name: "read", args: { path: "/x/test/build.go" } },
			]),
		]);

		expect(scan.calls[0].verifierKind).toBeNull();
	});

	it("pairs the classification with the outcome the result already carries", () => {
		const scan = readTurns("s1", [
			assistant("a1", [bash("t1", "go test ./...")]),
			result("t1", "FAIL", true),
		]);

		expect(scan.calls[0].verifierKind).toBe("test");
		expect(scan.calls[0].isError).toBe(true);
	});
});
