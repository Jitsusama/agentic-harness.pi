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

/**
 * What pi sends while a message is still being written: the whole
 * message so far, on every delta. Shape taken from a real transcript
 * rather than guessed at.
 */
function streamingEvent(text: string, thinking = "working on it"): string {
	return JSON.stringify({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 1,
			delta: text.slice(-4),
			partial: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text },
				],
			},
		},
	});
}

describe("a stream that stops before the message does", () => {
	it("reports the text that had been streamed", () => {
		// A reviewer taken away at its budget never sends message_end,
		// so a parser watching only for that reports nothing at all and
		// the whole answer is lost. The words were on the wire.
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${streamingEvent('{"findings": [')}\n${streamingEvent('{"findings": [{"title": "a leak')}\n`,
		);

		expect(parser.finish().finalAssistantText).toBe(
			'{"findings": [{"title": "a leak',
		);
	});

	it("does not let a fragment replace an answer already finished", () => {
		// A reviewer can answer, call a tool to check itself, and be cut
		// off partway through a revision. Reporting only the fragment
		// throws away a complete answer that was already sent, which is
		// the same loss this change exists to stop, arriving by a
		// different door.
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${assistantEvent('{"findings": [{"subject": "the whole answer"}]}')}\n${streamingEvent(
				'{"findings": [{"subject": "a revi',
			)}\n`,
		);

		const said = parser.finish().finalAssistantText;
		expect(said).toContain("the whole answer");
		expect(said).toContain("a revi");
	});

	it("counts the turn it was cut off in, when the turn said what it cost", () => {
		// The cost of a stopped reviewer is the number that made the
		// incident visible in the first place. A run billed at nothing
		// for its longest turn hides the next one.
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					partial: {
						role: "assistant",
						content: [{ type: "text", text: "partway" }],
						usage: {
							input: 10,
							output: 5,
							totalTokens: 15,
							cost: { total: 2 },
						},
					},
				},
			})}\n`,
		);

		expect(parser.finish().usage?.cost.total).toBe(2);
	});

	it("prefers the finished message over the partials before it", () => {
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${streamingEvent("half of i")}\n${assistantEvent("half of it, then all of it")}\n`,
		);

		expect(parser.finish().finalAssistantText).toBe(
			"half of it, then all of it",
		);
	});

	it("counts what a turn cost once, however many updates carried it", () => {
		// A partial carries the turn's running usage, and a reader that
		// adds up every update bills the turn a hundred times over. The
		// numbers would look plausible, which is what makes it worth a
		// test: nothing downstream could tell.
		const parser = new ReviewerStreamParser();
		const running = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				partial: {
					role: "assistant",
					content: [{ type: "text", text: "partway" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 1 },
					},
				},
			},
		};

		parser.ingestChunk(
			`${JSON.stringify(running)}\n${JSON.stringify(running)}\n${JSON.stringify(
				running,
			)}\n`,
		);

		// Exactly once. An earlier version of this asserted "at most
		// once", which a reader that counted the turn at nothing would
		// also satisfy, and that is the opposite mistake.
		expect(parser.finish().usage?.cost.total).toBe(1);
	});

	it("does not let a later message's thinking erase a finished answer", () => {
		// After one message completes, the next begins as thinking with
		// no text yet. That must not count as the assistant having said
		// nothing.
		const parser = new ReviewerStreamParser();

		parser.ingestChunk(
			`${assistantEvent("the answer")}\n${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					partial: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "now what" }],
					},
				},
			})}\n`,
		);

		expect(parser.finish().finalAssistantText).toBe("the answer");
	});
});

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

		// Neither turn reports an explicit cost total, so each falls
		// back to the sum of its per-channel costs (0.9375) and the
		// run total is their sum.
		expect(parser.finish().usage).toEqual({
			tokens: { input: 30, output: 13, cacheRead: 6, cacheWrite: 4, total: 53 },
			cost: {
				input: 0.5,
				output: 1,
				cacheRead: 0.25,
				cacheWrite: 0.125,
				total: 1.875,
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

function verifyStart(callId: string, args: unknown): string {
	return `${JSON.stringify({
		type: "tool_execution_start",
		toolName: "verify_output",
		...(callId ? { toolCallId: callId } : {}),
		args,
	})}\n`;
}

function verifyEnd(callId: string, details: unknown = { ok: true }): string {
	return `${JSON.stringify({
		type: "tool_execution_end",
		toolName: "verify_output",
		...(callId ? { toolCallId: callId } : {}),
		result: { content: [], details },
	})}\n`;
}

describe("captureVerification pairing", () => {
	it("resolves each end against its own call id, whatever the end order", () => {
		const parser = new ReviewerStreamParser();
		parser.ingestChunk(verifyStart("c1", { stage: "council" }));
		parser.ingestChunk(verifyStart("c2", { stage: "judge" }));
		// End the second call first, then the first.
		parser.ingestChunk(verifyEnd("c2"));
		parser.ingestChunk(verifyEnd("c1"));
		const result = parser.finish();

		expect(result.verification?.stage).toBe("council");
		expect(result.verification?.attempts).toBe(2);
	});

	it("falls back to the last unkeyed start when an end has no call id", () => {
		const parser = new ReviewerStreamParser();
		parser.ingestChunk(verifyStart("", { stage: "critique" }));
		parser.ingestChunk(verifyEnd(""));

		expect(parser.finish().verification?.stage).toBe("critique");
	});

	it("evicts the oldest pending start once the bound is exceeded", () => {
		const parser = new ReviewerStreamParser();
		// Nine keyed starts exceed the pending bound of eight, so the
		// oldest (c1) is dropped while the newest (c9) survives.
		for (let n = 1; n <= 9; n++) {
			parser.ingestChunk(verifyStart(`c${n}`, { stage: `s${n}` }));
		}
		parser.ingestChunk(verifyEnd("c9"));
		expect(parser.finish().verification?.stage).toBe("s9");

		// A late end for the evicted call resolves no args, so no
		// stage is attributed.
		parser.ingestChunk(verifyEnd("c1"));
		expect(parser.finish().verification?.stage).toBeUndefined();
	});

	it("keeps a non-JSON verifier output as a raw string", () => {
		const parser = new ReviewerStreamParser();
		parser.ingestChunk(verifyStart("c1", { output: "not json {" }));
		parser.ingestChunk(verifyEnd("c1"));

		expect(parser.finish().verification?.output).toBe("not json {");
	});
});

describe("extractUsageFromPiStream", () => {
	it("falls back to the summed channel costs when no total is given", () => {
		const usage = {
			input: 1,
			output: 1,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		};

		expect(
			extractUsageFromPiStream(`${assistantEvent("ok", usage)}\n`)?.cost.total,
		).toBeCloseTo(0.3, 10);
	});

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
