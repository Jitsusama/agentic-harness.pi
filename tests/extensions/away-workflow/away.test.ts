import { describe, expect, it } from "vitest";
import {
	AWAY_ENTRY,
	savedSnapshotOf,
	statusText,
} from "../../../extensions/away-workflow/lifecycle.ts";
import {
	readsLikeDeparture,
	returnMessage,
} from "../../../extensions/away-workflow/messages.ts";
import type { HeldCall, Return } from "../../../lib/internal/away/state.ts";

function held(id: number, title: string): HeldCall {
	return {
		id,
		guard: "slack",
		title,
		fingerprint: `f${id}`,
		at: "2026-10-12T23:00:00.000Z",
	};
}

const CALLS = [held(1, "Send to #team"), held(2, "Send email")];

describe("what the model is told on the person's return", () => {
	it("lists what was held and decided, and approves none of it", () => {
		const back: Return = {
			since: "2026-10-12T22:00:00.000Z",
			held: CALLS,
			decided: [
				{
					question: "Which scope?",
					answer: "Large",
					by: "recommendation",
					at: "x",
				},
			],
		};

		const text = returnMessage(back) ?? "";

		expect(text).toContain("Deal with what they said first.");
		expect(text).toContain("- #1 Send to #team (slack)");
		expect(text).toContain("Nothing here is approved.");
		expect(text).toContain("they will be asked in its own panel");
		expect(text).toContain("Which scope? → Large (your recommendation)");
	});

	it("says nothing when nothing waited", () => {
		expect(
			returnMessage({ since: "x", held: [], decided: [] }),
		).toBeUndefined();
	});
});

describe("reading a departure", () => {
	it.each([
		"ok, I'm going to bed, keep working on the subquests",
		"heading to sleep now",
		"I'll be away for a few hours",
		"while I'm out, finish the plan",
		"keep going overnight please",
		"afk, carry on",
	])("reads %j as a departure", (text) => {
		expect(readsLikeDeparture(text)).toBe(true);
	});

	it.each([
		"it looks like you got yourself stuck behind dialogs requiring my input while i was sleeping",
		"why did you stop?",
		"the overnight build failed",
		"what happens when the user is away?",
	])("does not read %j as one", (text) => {
		expect(readsLikeDeparture(text)).toBe(false);
	});
});

describe("keeping an absence across a restart", () => {
	it("restores the latest snapshot on the branch", () => {
		const first = { since: "a", held: [], decided: [] };
		const second = { held: [CALLS[0]], decided: [] };
		const branch = [
			{ type: "custom", customType: AWAY_ENTRY, data: first },
			{ type: "message" },
			{ type: "custom", customType: AWAY_ENTRY, data: second },
			{ type: "custom", customType: "other", data: first },
		];

		expect(savedSnapshotOf(branch)).toEqual(second);
	});

	it("never falls back past an unreadable latest entry to an older absence", () => {
		const branch = [
			{
				type: "custom",
				customType: AWAY_ENTRY,
				data: { since: "a", held: [], decided: [] },
			},
			{ type: "custom", customType: AWAY_ENTRY, data: { held: "no" } },
		];

		expect(savedSnapshotOf(branch)).toBeUndefined();
	});

	it("shows how much is held in the footer while away", () => {
		expect(statusText({ since: "a", held: CALLS, decided: [] })).toBe(
			"away · 2 held",
		);
		expect(statusText({ since: "a", held: [], decided: [] })).toBe("away");
		expect(statusText({ held: [], decided: [] })).toBeUndefined();
	});
});
