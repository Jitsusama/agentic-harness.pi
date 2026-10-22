import { describe, expect, it } from "vitest";
import {
	askedNotice,
	carryOnText,
	endsAsking,
	freshCarryOn,
	shouldWait,
} from "../../../extensions/away-workflow/carry-on.ts";
import {
	MAX_NUDGES,
	type RunSummary,
} from "../../../extensions/away-workflow/keep-going.ts";

const open = { document: "PLAN-9", done: 1, total: 4, next: "Docs" };

function ran(lastText: string, toolCalls = 1): RunSummary {
	return { lastText, toolCalls, aborted: false };
}

describe("shouldWait", () => {
	it("waits after a run that left a plan in build open", () => {
		expect(
			shouldWait(ran("Merged the first piece."), open, freshCarryOn()),
		).toBe(true);
	});

	it("does not wait without an open plan", () => {
		const memory = freshCarryOn();
		expect(shouldWait(ran("Here you go."), undefined, memory)).toBe(false);
		expect(shouldWait(ran("All of it."), { ...open, done: 4 }, memory)).toBe(
			false,
		);
	});

	it("lets a run that said Done or Blocked rest", () => {
		const memory = freshCarryOn();
		expect(shouldWait(ran("Done: all shipped."), open, memory)).toBe(false);
		expect(shouldWait(ran("Blocked: needs your OTP."), open, memory)).toBe(
			false,
		);
	});

	it("does not wait after a run the person stopped", () => {
		expect(
			shouldWait({ ...ran("Half"), aborted: true }, open, freshCarryOn()),
		).toBe(false);
	});

	it("never carries on a reply that only talked, such as agreeing to wait", () => {
		expect(shouldWait(ran("Holding.", 0), open, freshCarryOn())).toBe(false);
	});

	it("stops after as many carry-ons as away mode allows nudges", () => {
		const memory = freshCarryOn();
		memory.carried = MAX_NUDGES;
		expect(shouldWait(ran("Next piece."), open, memory)).toBe(false);
	});
});

describe("what the session is told", () => {
	it("names the plan's next item", () => {
		const text = carryOnText(open, false);
		expect(text).toContain(
			"Nobody has answered for 10 minutes, and PLAN-9 has 3 open items. Next: Docs",
		);
		expect(text).toContain("If the user asked you to stop or wait");
		expect(text).toContain("`Done:` or `Blocked:`");
	});

	it("keeps a question standing and carries on with the rest", () => {
		expect(carryOnText(open, true)).toContain(
			"Your question stands for the user, who has been reached at their desktop.",
		);
	});
});

describe("a question left unanswered", () => {
	it("is read from the reply's last line", () => {
		expect(endsAsking("Built it.\n\nShall I merge it?\n")).toBe(true);
		expect(endsAsking("Is it? Yes.\nMerged.")).toBe(false);
		expect(endsAsking("")).toBe(false);
	});

	it("reaches the person once a stretch", () => {
		const memory = freshCarryOn();
		const notice = askedNotice("PLAN-9", "Built.\nShall I merge it?", memory);
		expect(notice).toEqual({
			title: "PLAN-9 asked you something",
			body: "Shall I merge it? It carries on with the rest meanwhile.",
			urgency: "normal",
		});
		expect(askedNotice("PLAN-9", "Again?", memory)).toBeUndefined();
	});
});
