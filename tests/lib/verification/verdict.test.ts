import { describe, expect, it } from "vitest";
import { fastLayerVerdict } from "../../../lib/verification/verdict.js";

const oneError = [
	{ path: "src/a.ts", line: 3, character: 8, message: "Type error" },
];

describe("fastLayerVerdict", () => {
	it("defers while a TDD loop is active", () => {
		const v = fastLayerVerdict({
			tddPhase: "red",
			attempts: 0,
			maxAttempts: 3,
			errors: oneError,
		});
		expect(v.action).toBe("skip");
		if (v.action === "skip") expect(v.reason).toMatch(/tdd/i);
	});

	it("passes when there are no errors", () => {
		const v = fastLayerVerdict({
			tddPhase: "idle",
			attempts: 0,
			maxAttempts: 3,
			errors: [],
		});
		expect(v.action).toBe("skip");
		if (v.action === "skip") expect(v.reason).toMatch(/clean|no/i);
	});

	it("injects a fix message while under the attempt cap", () => {
		const v = fastLayerVerdict({
			tddPhase: "idle",
			attempts: 1,
			maxAttempts: 3,
			errors: oneError,
		});
		expect(v.action).toBe("inject");
		if (v.action === "inject") {
			expect(v.attempt).toBe(2);
			expect(v.message).toContain("src/a.ts:3:8");
			expect(v.message).toContain("Type error");
		}
	});

	it("gives up once the attempt cap is reached", () => {
		const v = fastLayerVerdict({
			tddPhase: "idle",
			attempts: 3,
			maxAttempts: 3,
			errors: oneError,
		});
		expect(v.action).toBe("giveUp");
		if (v.action === "giveUp") expect(v.message).toMatch(/could not|still/i);
	});
});
