import { describe, expect, it } from "vitest";
import { handsRefusal } from "../../../extensions/mesh-workflow/joels-hands.ts";

describe("an ask for the person's hands", () => {
	it("is refused without his acts counted against the fewest", () => {
		const refused = handsRefusal(
			"May Joel touch the key at 02:00 for the switch?",
		);
		expect(refused).toContain('"his acts: N; the fewest: M"');
		expect(refused).toContain("May Joel touch the key at 02:00");
	});

	it("is refused for a sitting, a paste or an unlock, however it names him", () => {
		for (const text of [
			"Can you book a sitting of 15 minutes?",
			"Please ask Joel to paste the token into the prompt.",
			"He'd need to unlock 1Password; may his hands do it after lunch?",
			"Could the person sign in to the switch once?",
		]) {
			expect(handsRefusal(text), text).toBeDefined();
		}
	});

	it("goes when it counts his acts at the fewest", () => {
		expect(
			handsRefusal(
				"May Joel touch the key at 02:00? His acts: 1; the fewest: 1.",
			),
		).toBeUndefined();
	});

	it("goes when it counts more acts than the fewest and says why", () => {
		expect(
			handsRefusal(
				"May Joel paste it and touch the key? his acts: 2; the fewest: 1, since the paste can't reach root without the touch.",
			),
		).toBeUndefined();
	});

	it("is refused when it counts more acts than the fewest and says nothing of why", () => {
		const refused = handsRefusal(
			"May Joel paste it and touch the key? his acts: 2; the fewest: 1",
		);
		expect(refused).toContain("2 acts where 1 would do");
	});

	it("goes when it asks nothing of his hands", () => {
		for (const text of [
			"May I build the catalogue tonight, off behind its option?",
			"Joel's yes is needed in the morning: keep it or roll it back?",
			"Should the check touch the network?",
		]) {
			expect(handsRefusal(text), text).toBeUndefined();
		}
	});
});
