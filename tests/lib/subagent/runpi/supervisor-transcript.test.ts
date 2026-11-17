/**
 * What the supervisor makes of a reviewer's event stream: its answer,
 * finished or cut off, what it spent, how it ended, and what
 * verify_output accepted. The supervisor's own suites run these through
 * a real child; here each rule is held to one event at a time.
 */

import { describe, expect, it } from "vitest";
import { UNFINISHED } from "../../../../lib/subagent/reviewer-error.ts";
import {
	summarizeActivity,
	transcript,
} from "../../../../lib/subagent/runpi/supervisor-transcript.mjs";

/** A transcript with a cap of `max` bytes, and the warnings it gave. */
function reading(max = 1_000) {
	const warnings: string[] = [];
	const said = transcript({
		maxAssistantTextBytes: max,
		warn: (message) => warnings.push(message),
	});
	return { said, warnings };
}

/** Usage pi reports for one turn, tokens and cost. */
function turnUsage(input: number, cost: number) {
	return { input, output: 1, cost: { input: cost, total: cost } };
}

/** A finished assistant message, as pi's message_end carries it. */
function finished(text: string, extra: Record<string, unknown> = {}) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			...extra,
		},
	};
}

/** An assistant message still being written. */
function partial(text: string, extra: Record<string, unknown> = {}) {
	return {
		type: "message_update",
		assistantMessageEvent: {
			partial: {
				role: "assistant",
				content: [{ type: "text", text }],
				...extra,
			},
		},
	};
}

/** verify_output's start and end, accepted or not. */
function verifyCall(id: string, output: unknown, ok: boolean) {
	return [
		{
			type: "tool_execution_start",
			toolName: "verify_output",
			toolCallId: id,
			args: { output },
		},
		{
			type: "tool_execution_end",
			toolName: "verify_output",
			toolCallId: id,
			result: {
				content: [{ type: "text", text: ok ? "fine" : "rejected" }],
				details: { ok, stage: "council", count: 2 },
			},
		},
	];
}

describe("a reviewer's answer", () => {
	it("is its last finished message, and the sessions it announced", () => {
		const { said } = reading();
		said.read({ type: "session", id: "s-1" });
		said.read(finished("first"));
		said.read(finished("second", { stopReason: "stop" }));
		said.read({ type: "agent_end" });

		expect(said.answer().text).toBe("second");
		expect(said.sessionIds).toEqual(["s-1"]);
		expect(said.error("complete"), "it ended cleanly").toBeUndefined();
	});

	it("keeps what a turn nobody let finish had said, after what was finished", () => {
		const { said } = reading();
		said.read(finished("done"));
		said.read(partial("still writ"));

		expect(said.answer().text).toBe("done\n\nstill writ");
	});

	it("counts a turn once when its partials end in its finished message", () => {
		const { said } = reading();
		said.read(partial("draf", { usage: turnUsage(5, 0.05) }));
		said.read(finished("draft", { usage: turnUsage(6, 0.06) }));
		said.read({ type: "agent_end" });

		expect(said.answer().text, "the partial is not said twice").toBe("draft");
		const spent = said.usage();
		expect(spent?.tokens.input, "the partial is not billed beside it").toBe(6);
		expect(spent?.cost.total).toBeCloseTo(0.06);
	});

	it("is cut to its byte cap on a character's edge, saying so", () => {
		const { said, warnings } = reading(5);
		said.read(finished("ééé"));

		expect(said.answer().text, "two whole characters, not two and a half").toBe(
			"éé",
		);
		expect(warnings).toEqual([
			"Reviewer assistant text exceeded 5 bytes; truncated",
		]);
	});

	it("steps back over every byte of a longer character the cap cuts into", () => {
		const { said } = reading(5);
		said.read(finished("a😀😀"));

		expect(said.answer().text, "one byte and one emoji, no split one").toBe(
			"a😀",
		);
	});

	it("reads the same however often it is asked", () => {
		const { said } = reading(10);
		for (const event of verifyCall("v1", { long: "x".repeat(20) }, true))
			said.read(event);

		expect(said.answer()).toEqual(said.answer());
	});
});

describe("what a reviewer spent", () => {
	it("sums its finished turns and counts the one in flight once", () => {
		const { said } = reading();
		said.read(finished("a", { usage: turnUsage(10, 0.1) }));
		said.read(finished("b", { usage: turnUsage(20, 0.2) }));
		said.read(partial("c", { usage: turnUsage(5, 0.05) }));
		said.read(partial("cc", { usage: turnUsage(7, 0.07) }));

		const spent = said.usage();
		expect(spent?.tokens.input, "a partial's total replaces the last").toBe(37);
		expect(spent?.cost.total).toBeCloseTo(0.37);
	});

	it("is nothing when no turn reported any", () => {
		expect(reading().said.usage()).toBeUndefined();
	});
});

describe("how a reviewer's run ended", () => {
	it("on an error when its last finished turn stopped on one", () => {
		const { said } = reading();
		said.read(
			finished("", { stopReason: "error", errorMessage: "overloaded" }),
		);

		expect(said.error("complete")).toEqual({
			stopReason: "error",
			message: "overloaded",
		});
		expect(said.error("timeout"), "a turn's error outranks a stop").toEqual({
			stopReason: "error",
			message: "overloaded",
		});
		said.read({ type: "agent_end" });
		expect(said.error("complete"), "and the run's end").toEqual({
			stopReason: "error",
			message: "overloaded",
		});
	});

	it("unfinished when it exited cleanly before its run ended, naming the tools still running", () => {
		const { said } = reading();
		said.read({
			type: "tool_execution_start",
			toolName: "web_read",
			toolCallId: "t1",
		});

		expect(said.error("complete")).toEqual({
			stopReason: UNFINISHED,
			message:
				"pi exited with code 0 while web_read was still running, before its run ended; whatever it was working towards was never said.",
		});
		expect(said.error("timeout"), "a stop says why on its own").toBeUndefined();
	});

	it("ended when the line too large to read was its agent_end", () => {
		const { said } = reading();
		said.skipped(`{"type":"agent_end","messages":[${"x".repeat(50)}`);

		expect(said.error("complete")).toBeUndefined();
	});

	it("loses nothing when the line too large to read only echoed what it was asked", () => {
		// pi echoes the prompt back as the user's message, twice, and a
		// council's brief runs past a megabyte. Skipping those lines costs
		// nothing the supervisor reads, so warning about them only put
		// two lines of noise on every reviewer of every large round.
		const { said } = reading();
		const asked = `{"message":{"role":"user","content":[{"type":"text","text":"${"x".repeat(50)}`;

		expect(
			said.skipped(`{"type":"message_start",${asked.slice(1)}`),
			"the prompt's echo as a message starts loses nothing",
		).toBe(false);
		expect(
			said.skipped(`{"type":"message_end",${asked.slice(1)}`),
			"the prompt's echo as a message ends loses nothing",
		).toBe(false);
		expect(
			said.skipped(
				`{"type":"message_end","message":{"role":"assistant","content":[${"x".repeat(50)}`,
			),
			"the reviewer's own answer is a loss",
		).toBe(true);
	});
});

describe("what verify_output accepted", () => {
	it("becomes the answer as JSON, its output kept off the verification", () => {
		const { said } = reading();
		for (const event of verifyCall("v1", '{"findings":[]}', true))
			said.read(event);

		const answer = said.answer();
		expect(answer.text).toBe(JSON.stringify({ findings: [] }, null, 2));
		expect(answer.verification).toEqual({
			called: true,
			ok: true,
			stage: "council",
			count: 2,
			message: "fine",
			canonicalText: true,
		});
	});

	it("leaves what was said as the answer when it refused", () => {
		const { said } = reading();
		said.read(finished("my answer"));
		for (const event of verifyCall("v1", "{}", false)) said.read(event);

		const answer = said.answer();
		expect(answer.text).toBe("my answer");
		expect(answer.verification).toMatchObject({
			ok: false,
			message: "rejected",
		});
	});

	it("is refused when its output is past the cap, saying so", () => {
		const { said, warnings } = reading(10);
		for (const event of verifyCall("v1", { long: "x".repeat(20) }, true))
			said.read(event);

		const answer = said.answer();
		expect(answer.text).toBe("");
		expect(answer.verification).toMatchObject({ ok: false });
		expect(warnings).toEqual([
			"Reviewer verified output exceeded 10 bytes; ignored",
		]);
	});

	it("gives way to the envelope written out-of-band, which keeps its output", () => {
		const { said } = reading();
		for (const event of verifyCall("v1", "{}", true)) said.read(event);
		const written = {
			called: true,
			ok: true,
			outOfBand: true,
			output: { big: true },
		};
		said.adopt(written);
		said.adopt(undefined);

		const answer = said.answer();
		expect(answer.text, "the parent reads it from the result").toBe("");
		expect(answer.verification).toEqual(written);
	});
});

describe("what an event says the reviewer is doing", () => {
	it("names the tool and a glance of its argument", () => {
		expect(
			summarizeActivity({
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "pnpm  exec\nvitest run" },
			}),
		).toBe("bash pnpm exec vitest run");
		expect(
			summarizeActivity({ type: "tool_execution_end", toolName: "read" }),
		).toBe("finished reading; waiting for model");
		expect(
			summarizeActivity({ type: "tool_execution_start", toolName: "lsp" }),
		).toBe("running lsp");
		expect(summarizeActivity({ type: "message_end" })).toBeNull();
	});
});
