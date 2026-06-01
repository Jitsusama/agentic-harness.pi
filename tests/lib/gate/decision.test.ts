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
		const decision = decideGate(violations, [], format, RELENT, "body one");
		expect(decision.action).toBe("block");
		expect(decision.message).toBe("emdash:\u2014");
		expect(decision.message).not.toContain(RELENT);
	});

	it("relents when the identical artifact was already blocked", () => {
		const violations = [{ kind: "emdash", found: "\u2014" }];
		const artifact = "the cat\u2014dog ran";
		const sig = violationSignature(violations, artifact);
		const decision = decideGate(violations, [sig], format, RELENT, artifact);
		expect(decision.action).toBe("relent");
		expect(decision.message).toContain(RELENT);
		expect(decision.message).toContain("emdash");
	});

	it("blocks again when the violation set changed", () => {
		const first = [{ kind: "spelling", found: "color" }];
		const second = [{ kind: "spelling", found: "behavior" }];
		const decision = decideGate(
			second,
			[violationSignature(first, "a")],
			format,
			RELENT,
			"b",
		);
		expect(decision.action).toBe("block");
	});

	it("signs two different artifacts with the same violation shape differently", () => {
		const a = [{ kind: "emdash", found: "\u2014" }];
		const b = [{ kind: "emdash", found: "\u2014" }];
		expect(violationSignature(a, "the cat\u2014dog ran")).not.toBe(
			violationSignature(b, "totally\u2014different content"),
		);
	});

	it("signs the identical artifact and violation set identically", () => {
		const v = [{ kind: "emdash", found: "\u2014" }];
		expect(violationSignature(v, "same body\u2014here")).toBe(
			violationSignature(v, "same body\u2014here"),
		);
	});

	it("blocks a different artifact that carries the same emdash violation shape", () => {
		const first = [{ kind: "emdash", found: "\u2014" }];
		const second = [{ kind: "emdash", found: "\u2014" }];
		const priorSig = violationSignature(first, "PR A: the cat\u2014dog ran");
		const decision = decideGate(
			second,
			[priorSig],
			format,
			RELENT,
			"Commit B: totally\u2014different",
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
