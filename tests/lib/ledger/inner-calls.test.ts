/**
 * The calls a tool made to other tools: a codemode script's, which pi
 * keeps on its result, and a gateway call's, which names its tool in its
 * arguments. Kept apart from the log's own calls, so a script still
 * counts as one call where calls are counted.
 */
import { describe, expect, it } from "vitest";
import { openTurnStore } from "../../../lib/core/observability/ledger/index.ts";
import { readTurns } from "../../../lib/ledger/index.ts";

function assistant(
	id: string,
	calls: Array<{ id: string; name: string; args: unknown }>,
): string {
	return JSON.stringify({
		id,
		type: "message",
		timestamp: "2026-11-12T08:00:00.000Z",
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

function result(
	callId: string,
	toolName: string,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id: `r-${callId}`,
		type: "message",
		timestamp: "2026-11-12T08:00:02.000Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			isError: false,
			content: [{ type: "text", text: "done" }],
			...extra,
		},
	});
}

const SCRIPT = { id: "t1", name: "codemode", args: { code: "..." } };

describe("the calls a tool made to other tools", () => {
	it("reads a script's calls from pi's own record, a gateway call by its tool", () => {
		const scan = readTurns("s1", [
			assistant("a1", [SCRIPT]),
			result("t1", "codemode", {
				nestedCalls: {
					complete: true,
					calls: [
						{ id: "t1/1", name: "quest", status: "ok", durationMs: 162 },
						{
							id: "t1/2",
							name: "tool_gateway_run_tool",
							arguments: { name: "slack_search", arguments: { q: "x" } },
							status: "error",
						},
					],
				},
				details: { calls: [{ id: "t1/1", name: "read", status: "ok" }] },
			}),
		]);

		expect(
			scan.inner.map((c) => [
				c.outerCallId,
				c.name,
				c.via,
				c.status,
				c.durationMs,
			]),
			"pi's record wins over the tool's own details",
		).toEqual([
			["t1", "quest", "codemode", "ok", 162],
			["t1", "slack_search", "tool_gateway_run_tool", "error", null],
		]);
		expect(
			scan.calls.map((c) => c.name),
			"the log's own calls",
		).toEqual(["codemode"]);
	});

	it("reads a script's calls from its details when pi kept none", () => {
		const scan = readTurns("s1", [
			assistant("a1", [SCRIPT]),
			result("t1", "codemode", {
				details: {
					calls: [
						{
							id: "t1/1",
							name: "read",
							args: '{"path":"/x"}',
							status: "ok",
							durationMs: 12.5,
						},
						{
							id: "t1/2",
							name: "tool_gateway_run_tool",
							args: '{"name":"vault_search"}',
							status: "ok",
						},
					],
				},
			}),
		]);

		expect(
			scan.inner.map((c) => [c.name, c.via, c.durationMs]),
			"each call, a gateway call by its tool",
		).toEqual([
			["read", "codemode", 13],
			["vault_search", "tool_gateway_run_tool", null],
		]);
	});

	it("names the tool a gateway call ran, as one call beside the log's own", () => {
		const scan = readTurns("s1", [
			assistant("a1", [
				{
					id: "t1",
					name: "tool_gateway_run_tool",
					args: { name: "incident_list", arguments: {} },
				},
			]),
			result("t1", "tool_gateway_run_tool"),
		]);

		expect(
			[
				scan.calls.map((c) => c.name),
				scan.inner.map((c) => [c.outerCallId, c.name, c.via, c.status]),
			],
			"the gateway call, and the tool it ran",
		).toEqual([
			["tool_gateway_run_tool"],
			[["t1", "incident_list", "tool_gateway_run_tool", "ok"]],
		]);
	});

	it("keeps no arguments", () => {
		const scan = readTurns("s1", [
			assistant("a1", [SCRIPT]),
			result("t1", "codemode", {
				nestedCalls: {
					complete: true,
					calls: [
						{
							id: "t1/1",
							name: "bash",
							arguments: { command: "cat secret-token" },
							status: "ok",
						},
					],
				},
			}),
		]);

		expect(
			[scan.inner.length, JSON.stringify(scan.inner).includes("secret")],
			"one call, no argument text",
		).toEqual([1, false]);
	});

	it("is kept once however many forked logs repeat it", async () => {
		const scan = readTurns("s1", [
			assistant("a1", [SCRIPT]),
			result("t1", "codemode", {
				nestedCalls: {
					complete: true,
					calls: [{ id: "t1/1", name: "quest", status: "ok" }],
				},
			}),
		]);
		const store = await openTurnStore(":memory:");
		const first = await store.recordInnerCalls(scan.inner);
		const again = await store.recordInnerCalls(scan.inner);
		const held = await store.queryInnerCalls();
		await store.close();

		expect(
			[first.inserted, again.inserted, held.map((c) => [c.name, c.via])],
			"written once, read back",
		).toEqual([1, 0, [["quest", "codemode"]]]);
	});
});
