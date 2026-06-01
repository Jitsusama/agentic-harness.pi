import { describe, expect, it } from "vitest";
import {
	detectProseViolations,
	proseGateDecision,
	violationSignature,
} from "../../../lib/prose/index.js";

describe("proseGateDecision", () => {
	it("allows clean prose", () => {
		const decision = proseGateDecision(
			detectProseViolations("All clean."),
			[],
			"All clean.",
		);
		expect(decision.action).toBe("allow");
	});

	it("blocks the first time a violation is seen", () => {
		const text = "Pick a color.";
		const decision = proseGateDecision(detectProseViolations(text), [], text);
		expect(decision.action).toBe("block");
		expect(decision.message).toContain("colour");
	});

	it("relents when the identical body was already blocked", () => {
		const text = "Pick a color.";
		const violations = detectProseViolations(text);
		const sig = violationSignature(violations, text);
		const decision = proseGateDecision(violations, [sig], text);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/could not|still|let/i);
	});

	it("blocks a different body that breaks the same way", () => {
		const first = "Pick a color.";
		const second = "Choose a color.";
		const decision = proseGateDecision(
			detectProseViolations(second),
			[violationSignature(detectProseViolations(first), first)],
			second,
		);
		expect(decision.action).toBe("block");
	});

	it("gives the same signature regardless of violation order", () => {
		const a = detectProseViolations("color then behavior.");
		const b = detectProseViolations("behavior then color.");
		expect(violationSignature(a)).toBe(violationSignature(b));
	});
});
