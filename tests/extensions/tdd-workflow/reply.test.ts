import { describe, expect, it } from "vitest";
import { formatTransitionReply } from "../../../extensions/tdd-workflow/reply.js";

describe("formatTransitionReply", () => {
	it("marks a landed transition as an advance into the new phase", () => {
		const text = formatTransitionReply({
			outcome: "advanced",
			loop: {
				phase: "red",
				assertionFailure: true,
				behaviour: "b",
				iteration: 1,
			},
			discipline:
				"The failure has to be a real assertion, not a missing symbol.",
		});
		// The agent must read this as success, not a correction.
		expect(text).toMatch(/^✓/);
		expect(text).toMatch(/red/);
		// The phase discipline still rides along as the reminder.
		expect(text).toContain("real assertion");
	});

	it("marks a refusal distinctly and names the phase that held", () => {
		const text = formatTransitionReply({
			outcome: "refused",
			loop: {
				phase: "write",
				assertionFailure: false,
				behaviour: "b",
				iteration: 1,
			},
			guidance: "You haven't seen a real red yet.",
		});
		expect(text).toMatch(/^✗/);
		expect(text).toMatch(/refus/i);
		expect(text).toContain("write");
		expect(text).toContain("You haven't seen a real red yet.");
	});

	it("never opens a success and a refusal with the same marker", () => {
		const success = formatTransitionReply({
			outcome: "advanced",
			loop: {
				phase: "green",
				assertionFailure: false,
				behaviour: "b",
				iteration: 1,
			},
			discipline: "Write the minimum code to pass.",
		});
		const refusal = formatTransitionReply({
			outcome: "refused",
			loop: {
				phase: "red",
				assertionFailure: true,
				behaviour: "b",
				iteration: 1,
			},
			guidance: "Report the passing result before green.",
		});
		expect(success[0]).not.toBe(refusal[0]);
	});
});
