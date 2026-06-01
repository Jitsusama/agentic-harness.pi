import { describe, expect, it } from "vitest";
import {
	detectProseViolations,
	proseGateDecision,
	violationSignature,
} from "../../../lib/prose/index.js";

describe("proseGateDecision", () => {
	it("allows clean prose", () => {
		const decision = proseGateDecision(detectProseViolations("All clean."), []);
		expect(decision.action).toBe("allow");
	});

	it("blocks the first time a violation is seen", () => {
		const violations = detectProseViolations("Pick a color.");
		const decision = proseGateDecision(violations, []);
		expect(decision.action).toBe("block");
		expect(decision.message).toContain("colour");
	});

	it("relents when the same violation set was already blocked", () => {
		const violations = detectProseViolations("Pick a color.");
		const sig = violationSignature(violations);
		const decision = proseGateDecision(violations, [sig]);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/could not|still|let/i);
	});

	it("blocks again when the violation set changed", () => {
		const first = detectProseViolations("Pick a color.");
		const second = detectProseViolations("Pick a behavior.");
		const decision = proseGateDecision(second, [violationSignature(first)]);
		expect(decision.action).toBe("block");
	});

	it("gives the same signature regardless of violation order", () => {
		const a = detectProseViolations("color then behavior.");
		const b = detectProseViolations("behavior then color.");
		expect(violationSignature(a)).toBe(violationSignature(b));
	});
});
