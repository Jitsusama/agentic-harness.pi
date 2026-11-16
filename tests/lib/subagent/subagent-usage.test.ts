/**
 * The tokens and cost `runReviewer` reads out of a reviewer's stream.
 */

import { describe, expect, it } from "vitest";
import { assistantEvent, fakeRun, review } from "./fake-runs.ts";

describe("runReviewer: usage extraction", () => {
	it("returns the token + cost usage from the final assistant message", async () => {
		// Pi emits a `usage` block on every assistant
		// message_end event (cumulative). The terminal
		// `agent_end` event also carries the final cumulative
		// usage on the trailing assistant message. We use the
		// last assistant message_end's usage as the canonical
		// per-reviewer total: token counts (input, output,
		// cacheRead, cacheWrite, total) and dollar cost
		// (input, output, cacheRead, cacheWrite, total).
		const { runPi } = fakeRun({
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 1234,
						output: 567,
						cacheRead: 89,
						cacheWrite: 4321,
						totalTokens: 6211,
						cost: {
							input: 0.001,
							output: 0.002,
							cacheRead: 0.0001,
							cacheWrite: 0.05,
							total: 0.0531,
						},
					},
				},
			}),
		});
		const result = await review(runPi);
		expect(result.usage).toEqual({
			tokens: {
				input: 1234,
				output: 567,
				cacheRead: 89,
				cacheWrite: 4321,
				total: 6211,
			},
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.05,
				total: 0.0531,
			},
		});
	});

	it("sums usage across every assistant message_end in the stream", async () => {
		// A multi-step turn emits one message_end per LLM
		// round-trip, each carrying that request's own usage
		// (not a running total). The run's true usage is their
		// sum, so the dispatcher accumulates rather than
		// keeping only the last.
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						usage: {
							input: 100,
							output: 50,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 150,
							cost: { total: 0.01 },
						},
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final" }],
						usage: {
							input: 200,
							output: 100,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 300,
							cost: { total: 0.02 },
						},
					},
				}),
			].join("\n"),
		});
		const result = await review(runPi);
		expect(result.usage?.tokens.total).toBe(450);
		expect(result.usage?.cost.total).toBeCloseTo(0.03);
	});

	it("ignores usage on non-assistant messages", async () => {
		// User and tool_result message_end events also
		// include usage fields in some flows. Only the
		// assistant role's usage counts toward reviewer cost.
		const { runPi } = fakeRun({
			stdout: [
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { total: 0.001 },
						},
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "user",
						content: [{ type: "text", text: "trailing" }],
						usage: {
							input: 9999,
							output: 9999,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 19998,
							cost: { total: 99.99 },
						},
					},
				}),
			].join("\n"),
		});
		const result = await review(runPi);
		expect(result.usage?.tokens.total).toBe(15);
		expect(result.usage?.cost.total).toBeCloseTo(0.001);
	});

	it("leaves usage undefined when the stream contains no usage blocks", async () => {
		// Older pi versions or stubbed test runners may not
		// emit usage. The dispatcher treats it as optional
		// and lets callers fall back to "unknown".
		const { runPi } = fakeRun({
			stdout: assistantEvent("no usage in this stream"),
		});
		const result = await review(runPi);
		expect(result.usage).toBeUndefined();
	});

	it("tolerates partial cost objects (missing breakdown keys)", async () => {
		// Pi's cost block sometimes only ships `total` (e.g.
		// providers without per-channel pricing). Missing
		// breakdown keys default to zero so summing works.
		const { runPi } = fakeRun({
			stdout: JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: {
						input: 10,
						output: 20,
						totalTokens: 30,
						cost: { total: 0.5 },
					},
				},
			}),
		});
		const result = await review(runPi);
		expect(result.usage).toEqual({
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
