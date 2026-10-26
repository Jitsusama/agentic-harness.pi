import { describe, expect, it } from "vitest";
import {
	detectSectionViolations,
	PR_SECTIONS,
	PR_SHAPE,
	sectionGateDecision,
	violationSignature,
} from "../../../lib/core/sections/index.ts";

const PR_CONFIG = {
	sanctioned: PR_SECTIONS,
	entityLabel: "PR",
	skill: "github-pr-format",
};

const clean = [
	"### 💡 TL;DR",
	"Fixed.",
	"### 🧩 Problem",
	"broken",
	"### 🔧 Solution",
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
			invented,
		);
		const decision = sectionGateDecision(invented, [sig], PR_CONFIG);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/still|remaining|yourself/i);
	});

	it("blocks a different section problem even after one relented", () => {
		const firstSig = violationSignature(
			detectSectionViolations(invented, PR_SECTIONS),
			invented,
		);
		const other = `${clean}\n### Notes\nstuff`;
		const decision = sectionGateDecision(other, [firstSig], PR_CONFIG);
		expect(decision.action).toBe("block");
	});
});

describe("sectionGateDecision with a shape", () => {
	const SHAPED = { ...PR_CONFIG, shape: PR_SHAPE };
	const rambling = clean.replace(
		"Fixed.",
		"It was broken. Then we looked. Then we fixed it.",
	);

	it("ignores the shape when the config carries none", () => {
		expect(sectionGateDecision(rambling, [], PR_CONFIG).action).toBe("allow");
	});

	it("blocks a section out of its shape, saying which rule", () => {
		const decision = sectionGateDecision(rambling, [], SHAPED);
		expect(decision.action).toBe("block");
		expect(decision.message).toContain("TL;DR is 3 sentences");
	});

	it("reports headings and shape in one message, headings first", () => {
		const decision = sectionGateDecision(
			`${rambling}\n### Notes\nstuff`,
			[],
			SHAPED,
		);
		const headings = decision.message.indexOf("### Notes");
		const shape = decision.message.indexOf("TL;DR is 3 sentences");
		expect(headings).toBeGreaterThanOrEqual(0);
		expect(shape).toBeGreaterThan(headings);
	});

	it("relents on the identical body, as it does for headings", () => {
		const first = sectionGateDecision(rambling, [], SHAPED);
		const again = sectionGateDecision(rambling, [first.signature], SHAPED);
		expect(again.action).toBe("relent");
	});
});
