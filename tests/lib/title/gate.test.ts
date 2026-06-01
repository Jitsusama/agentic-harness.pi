import { describe, expect, it } from "vitest";
import { violationSignature } from "../../../lib/gate/index.js";
import {
	detectTitleViolations,
	titleGateDecision,
} from "../../../lib/title/index.js";

const PR_CONFIG = { entityLabel: "PR", skill: "github-pr-format" };
const cc = "chore(monitoring): define the policies as code";

describe("titleGateDecision", () => {
	it("allows a descriptive title", () => {
		expect(
			titleGateDecision("Define the Policies as Reviewable Code", [], PR_CONFIG)
				.action,
		).toBe("allow");
	});

	it("blocks a conventional-commit title the first time", () => {
		const decision = titleGateDecision(cc, [], PR_CONFIG);
		expect(decision.action).toBe("block");
		expect(decision.message).toContain("chore(monitoring):");
	});

	it("relents when the identical title was already blocked", () => {
		const sig = violationSignature(detectTitleViolations(cc), cc);
		const decision = titleGateDecision(cc, [sig], PR_CONFIG);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/still|yourself|let/i);
	});

	it("blocks a different conventional-commit title even after one relented", () => {
		const sig = violationSignature(detectTitleViolations(cc), cc);
		const other = "feat: add the other thing";
		expect(titleGateDecision(other, [sig], PR_CONFIG).action).toBe("block");
	});
});
