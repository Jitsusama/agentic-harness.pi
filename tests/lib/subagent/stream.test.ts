import { describe, expect, it } from "vitest";
import {
	extractUsageFromPiStream,
	ReviewerStreamParser,
} from "../../../lib/subagent/stream.js";

function assistantEvent(text: string, usage?: unknown): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			...(usage ? { usage } : {}),
		},
	});
}

describe("ReviewerStreamParser", () => {
	it("extracts the final assistant text without retaining full stdout", () => {
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${assistantEvent("first")}\n${assistantEvent("second")}\n`,
		);

		expect(parser.finish().finalAssistantText).toBe("second");
	});

	it("emits parsed stream events as chunks arrive", () => {
		const parser = new ReviewerStreamParser();

		const events = parser.ingestChunk(
			'{"type":"tool_execution_start","toolName":"read","args":{"path":"task.go"}}\n',
		);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "tool_execution_start",
			toolName: "read",
		});
	});

	it("reassembles JSON lines split across chunks", () => {
		const parser = new ReviewerStreamParser();

		expect(parser.ingestChunk('{"type":"tool_execu')).toEqual([]);
		const events = parser.ingestChunk('tion_end","toolName":"read"}\n');

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "tool_execution_end",
			toolName: "read",
		});
	});

	it("counts verify_output attempts and keeps the last result", () => {
		const parser = new ReviewerStreamParser();
		const end = (ok: boolean) =>
			`${JSON.stringify({
				type: "tool_execution_end",
				toolName: "verify_output",
				result: { content: [], details: { ok } },
			})}\n`;
		parser.ingestChunk(end(false));
		parser.ingestChunk(end(true));
		const result = parser.finish();

		expect(result.verification?.ok).toBe(true);
		expect(result.verification?.attempts).toBe(2);
	});

	it("concatenates multiple text blocks in an assistant message", () => {
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				},
			}),
		);

		expect(parser.finish().finalAssistantText).toBe("first\nsecond");
	});

	it("extracts a single turn's assistant usage", () => {
		const usage = {
			input_tokens: 1,
			output_tokens: 2,
			cache_read_input_tokens: 3,
			cache_creation_input_tokens: 4,
			cost_usd: 0.5,
		};
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(`${assistantEvent("ok", usage)}\n`);

		expect(parser.finish().usage).toEqual({
			tokens: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				total: 10,
			},
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.5,
			},
		});
	});

	it("sums token tiers and cost across every assistant message_end", () => {
		// A multi-turn subagent emits one message_end per turn,
		// each with its own usage. The run's true cost is the
		// sum, so keeping only the last turn undercounts a long
		// run roughly in proportion to its turn count.
		const turn1 = {
			input_tokens: 10,
			output_tokens: 5,
			cache_read_input_tokens: 2,
			cache_creation_input_tokens: 1,
			cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 0.0625 },
		};
		const turn2 = {
			input_tokens: 20,
			output_tokens: 8,
			cache_read_input_tokens: 4,
			cache_creation_input_tokens: 3,
			cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 0.0625 },
		};
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${assistantEvent("t1", turn1)}\n${assistantEvent("t2", turn2)}\n`,
		);

		expect(parser.finish().usage).toEqual({
			tokens: { input: 30, output: 13, cacheRead: 6, cacheWrite: 4, total: 53 },
			cost: {
				input: 0.5,
				output: 1,
				cacheRead: 0.25,
				cacheWrite: 0.125,
				total: 0,
			},
		});
	});

	it("caps malformed JSON warnings", () => {
		const parser = new ReviewerStreamParser({ maxWarnings: 2 });

		parser.ingestChunk("nope\nstill nope\nthird nope\n");

		expect(parser.finish().warnings).toHaveLength(2);
	});

	it("drops a line that exceeds the configured line limit", () => {
		const parser = new ReviewerStreamParser({ maxLineBytes: 256 });

		parser.ingestChunk(`${"x".repeat(300)}\n${assistantEvent("ok")}\n`);
		const result = parser.finish();

		expect(result.finalAssistantText).toBe("ok");
		expect(result.warnings.some((w) => w.includes("exceeded"))).toBe(true);
	});

	it("truncates oversized assistant text", () => {
		const parser = new ReviewerStreamParser({ maxAssistantTextBytes: 5 });

		parser.ingestChunk(`${assistantEvent("abcdefghij")}\n`);
		const result = parser.finish();

		expect(result.finalAssistantText).toBe("abcde");
		expect(result.truncated).toBe(true);
		expect(result.warnings.some((w) => w.includes("assistant text"))).toBe(
			true,
		);
	});

	it("handles an unterminated final line on finish", () => {
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(assistantEvent("ok"));

		expect(parser.finish().finalAssistantText).toBe("ok");
	});
});

describe("extractUsageFromPiStream", () => {
	it("uses the streaming parser for compatibility with existing callers", () => {
		const usage = {
			input_tokens: 10,
			output_tokens: 20,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			cost_usd: 0.5,
		};

		expect(
			extractUsageFromPiStream(`${assistantEvent("ok", usage)}\n`),
		).toEqual({
			tokens: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				total: 30,
			},
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.5,
			},
		});
	});
});
