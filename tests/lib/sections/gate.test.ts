import { describe, expect, it } from "vitest";
import {
	detectSectionViolations,
	PR_SECTIONS,
	sectionGateDecision,
	violationSignature,
} from "../../../lib/sections/index.js";

const PR_CONFIG = {
	sanctioned: PR_SECTIONS,
	entityLabel: "PR",
	skill: "github-pr-format",
};

const clean = [
	"### 🌐 Situation",
	"broken",
	"### 🔧 Resolution",
	"fixed",
	"### 🔬 Validation",
	"proven",
].join("\n");

const invented = `${clean}\n### Testing\nran it`;

describe("sectionGateDecision", () => {
	it("allows a body with exactly the sanctioned sections", () => {
		expect(sectionGateDecision(clean, [], PR_CONFIG).action).toBe("allow");
	});

	it("blocks the first time an invented section is seen", () => {
		const decision = sectionGateDecision(invented, [], PR_CONFIG);
		expect(decision.action).toBe("block");
		expect(decision.message).toContain("### Testing");
	});

	it("relents when the same section problem was already blocked", () => {
		const sig = violationSignature(
			detectSectionViolations(invented, PR_SECTIONS),
		);
		const decision = sectionGateDecision(invented, [sig], PR_CONFIG);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/still|remaining|yourself/i);
	});

	it("blocks a different section problem even after one relented", () => {
		const firstSig = violationSignature(
			detectSectionViolations(invented, PR_SECTIONS),
		);
		const other = `${clean}\n### Notes\nstuff`;
		const decision = sectionGateDecision(other, [firstSig], PR_CONFIG);
		expect(decision.action).toBe("block");
	});
});
