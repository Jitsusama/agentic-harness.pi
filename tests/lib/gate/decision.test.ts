import { describe, expect, it } from "vitest";
import { decideGate, violationSignature } from "../../../lib/gate/index.js";

interface TestViolation {
	kind: string;
	found: string;
}

const format = (violations: TestViolation[]): string =>
	violations.map((v) => `${v.kind}:${v.found}`).join(", ");

const RELENT = "relenting: ";

describe("decideGate", () => {
	it("allows an empty violation set", () => {
		const decision = decideGate<TestViolation>([], [], format, RELENT);
		expect(decision.action).toBe("allow");
		expect(decision.signature).toBe("");
		expect(decision.message).toBe("");
	});

	it("blocks the first time a violation set is seen", () => {
		const violations = [{ kind: "emdash", found: "\u2014" }];
		const decision = decideGate(violations, [], format, RELENT);
		expect(decision.action).toBe("block");
		expect(decision.message).toBe("emdash:\u2014");
		expect(decision.message).not.toContain(RELENT);
	});

	it("relents when the same violation set was already blocked", () => {
		const violations = [{ kind: "emdash", found: "\u2014" }];
		const sig = violationSignature(violations);
		const decision = decideGate(violations, [sig], format, RELENT);
		expect(decision.action).toBe("relent");
		expect(decision.message).toContain(RELENT);
		expect(decision.message).toContain("emdash");
	});

	it("blocks again when the violation set changed", () => {
		const first = [{ kind: "spelling", found: "color" }];
		const second = [{ kind: "spelling", found: "behavior" }];
		const decision = decideGate(
			second,
			[violationSignature(first)],
			format,
			RELENT,
		);
		expect(decision.action).toBe("block");
	});

	it("signs a violation set independent of order", () => {
		const a = [
			{ kind: "spelling", found: "color" },
			{ kind: "emdash", found: "\u2014" },
		];
		const b = [
			{ kind: "emdash", found: "\u2014" },
			{ kind: "spelling", found: "color" },
		];
		expect(violationSignature(a)).toBe(violationSignature(b));
	});

	it("signs case-insensitively on the found text", () => {
		const lower = [{ kind: "spelling", found: "color" }];
		const upper = [{ kind: "spelling", found: "Color" }];
		expect(violationSignature(lower)).toBe(violationSignature(upper));
	});
});
