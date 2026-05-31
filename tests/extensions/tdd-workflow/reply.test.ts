import { describe, expect, it } from "vitest";
import { formatTransitionReply } from "../../../extensions/tdd-workflow/reply.js";

describe("formatTransitionReply", () => {
	it("marks a landed transition as an advance into the new phase", () => {
		const text = formatTransitionReply({
			ok: true,
			state: {
				phase: "red",
				assertionFailure: true,
				behaviour: "b",
				iteration: 1,
			},
		});
		// The agent must read this as success, not a correction.
		expect(text).toMatch(/^✓/);
		expect(text).toMatch(/red/);
		// The phase discipline still rides along as the reminder.
		expect(text).toContain("real assertion");
	});

	it("marks a refusal distinctly and names the phase that held", () => {
		const text = formatTransitionReply(
			{ ok: false, guidance: "You haven't seen a real red yet." },
			"write",
		);
		expect(text).toMatch(/^✗/);
		expect(text).toMatch(/refus/i);
		expect(text).toContain("write");
		expect(text).toContain("You haven't seen a real red yet.");
	});

	it("never opens a success and a refusal with the same marker", () => {
		const success = formatTransitionReply({
			ok: true,
			state: {
				phase: "green",
				assertionFailure: false,
				behaviour: "b",
				iteration: 1,
			},
		});
		const refusal = formatTransitionReply(
			{ ok: false, guidance: "Report the passing result before green." },
			"red",
		);
		expect(success[0]).not.toBe(refusal[0]);
	});
});
