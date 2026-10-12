import { describe, expect, it } from "vitest";
import {
	type Absence,
	afterRun,
	combine,
	endingOf,
	freshMemory,
	MAX_IDLE_RUNS,
	MAX_NUDGES,
	type RunSummary,
	summarize,
} from "../../../extensions/away-workflow/keep-going.ts";

const ABSENCE: Absence = {
	since: "2026-10-12T22:00:00.000Z",
	goal: "work through the remaining subquests",
	held: 0,
};

function ran(lastText: string, toolCalls = 1): RunSummary {
	return { lastText, toolCalls, aborted: false };
}

describe("how a run said it ended", () => {
	it.each([
		["Done: all three PRs merged.", "done"],
		["Notes.\n\n**Blocked:** CI needs a secret only you have.", "blocked"],
		["- Done: shipped", "done"],
		["blocked: no access", "blocked"],
	] as const)("reads %j as %s", (text, ending) => {
		expect(endingOf(text)).toBe(ending);
	});

	it.each([
		"Blocked: the build.\n\nI'll try another approach next.",
		"Here's a summary of what I did.",
		"Should I go ahead with the PR?",
		"",
	])("reads %j as not ended", (text) => {
		expect(endingOf(text)).toBeUndefined();
	});
});

describe("after a run, while the person is away", () => {
	it("sends a run that did not say Done or Blocked back, with the goal", () => {
		const verdict = afterRun(
			ran("Summary of progress so far."),
			ABSENCE,
			freshMemory(),
		);

		expect(verdict.kind).toBe("nudge");
		const text = verdict.kind === "nudge" ? verdict.text : "";
		expect(text).toContain("work through the remaining subquests");
		expect(text).toContain("`Done:`");
		expect(text).toContain("`Blocked:`");
	});

	it("sends back a question, since nobody is there to answer it", () => {
		expect(
			afterRun(ran("Want me to open the PR?"), ABSENCE, freshMemory()).kind,
		).toBe("nudge");
	});

	it("names the plan's progress and what is held", () => {
		const verdict = afterRun(
			ran("ok"),
			{
				...ABSENCE,
				held: 2,
				progress: {
					document: "PLAN-1",
					done: 4,
					total: 10,
					next: "Write docs",
				},
			},
			freshMemory(),
		);

		const text = verdict.kind === "nudge" ? verdict.text : "";
		expect(text).toContain("PLAN-1: 4 of 10 items done. Next: Write docs");
		expect(text).toContain("2 calls are held");
	});

	it("lets a blocked run rest", () => {
		expect(
			afterRun(ran("Blocked: needs your login"), ABSENCE, freshMemory()),
		).toEqual({
			kind: "rest",
			why: "blocked",
		});
	});

	it("lets a done run rest when nothing says otherwise", () => {
		expect(afterRun(ran("Done: merged"), ABSENCE, freshMemory())).toEqual({
			kind: "rest",
			why: "done",
		});
	});

	it("sends a premature Done back once, then takes the model's word", () => {
		const memory = freshMemory();
		const absence = {
			...ABSENCE,
			progress: { document: "PLAN-1", done: 8, total: 10 },
		};

		const first = afterRun(ran("Done: finished"), absence, memory);
		const second = afterRun(
			ran("Done: the last two are out of scope"),
			absence,
			memory,
		);

		expect(first.kind === "nudge" && first.text).toContain(
			"still has 2 open items",
		);
		expect(second).toEqual({ kind: "rest", why: "done" });
	});

	it("stops after idle runs in a row, says so, and stays quiet", () => {
		const memory = freshMemory();
		const verdicts = Array.from({ length: MAX_IDLE_RUNS + 1 }, () =>
			afterRun(ran("thinking about it", 0), ABSENCE, memory),
		);

		expect(verdicts.slice(0, MAX_IDLE_RUNS - 1).map((v) => v.kind)).toEqual(
			Array(MAX_IDLE_RUNS - 1).fill("nudge"),
		);
		const warned = verdicts[MAX_IDLE_RUNS - 2];
		expect(warned?.kind === "nudge" && warned.text).toContain("one more");
		expect(verdicts[MAX_IDLE_RUNS - 1]?.kind).toBe("stop");
		expect(verdicts[MAX_IDLE_RUNS]?.kind).toBe("quiet");
	});

	it("does not count a run that used tools as idle", () => {
		const memory = freshMemory();
		for (let i = 0; i < MAX_IDLE_RUNS * 2; i++) {
			expect(afterRun(ran("still going", i % 2), ABSENCE, memory).kind).toBe(
				"nudge",
			);
		}
	});

	it("stops after the most nudges one absence allows, however busy", () => {
		const memory = freshMemory();
		for (let i = 0; i < MAX_NUDGES; i++) afterRun(ran("busy"), ABSENCE, memory);

		expect(afterRun(ran("busy"), ABSENCE, memory).kind).toBe("stop");
	});

	it("starts every absence with fresh bounds", () => {
		const memory = freshMemory();
		for (let i = 0; i < MAX_IDLE_RUNS; i++)
			afterRun(ran("", 0), ABSENCE, memory);

		expect(
			afterRun(ran("", 0), { ...ABSENCE, since: "later" }, memory).kind,
		).toBe("nudge");
	});
});

describe("reading a run from pi's messages", () => {
	it("takes the last assistant text, every tool call, and whether it was stopped", () => {
		const run = summarize([
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			{ role: "toolResult", content: [] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "last" },
					{ type: "toolCall", name: "bash" },
				],
				stopReason: "aborted",
			},
		]);

		expect(run).toEqual({ lastText: "last", toolCalls: 2, aborted: true });
	});

	it("adds up a run that ended more than once before it settled", () => {
		expect(
			combine(
				{ lastText: "a", toolCalls: 2, aborted: false },
				{ lastText: "b", toolCalls: 1, aborted: false },
			),
		).toEqual({ lastText: "b", toolCalls: 3, aborted: false });
	});
});
