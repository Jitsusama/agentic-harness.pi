import { describe, expect, it } from "vitest";
import {
	complaintsAbout,
	validate,
} from "../../../lib/internal/guardian/commit-format.js";

const GOOD = "feat(work): record a commit through the tool";

describe("judging a commit message", () => {
	it("accepts conventional form", () => {
		expect(validate(GOOD).conventionalOk).toBe(true);
		expect(complaintsAbout(GOOD)).toEqual([]);
	});

	it("accepts a scope with a slash or a dash", () => {
		expect(validate("fix(a/b-c): thing").conventionalOk).toBe(true);
	});

	it("accepts a breaking-change marker", () => {
		expect(validate("feat!: drop the old surface").conventionalOk).toBe(true);
	});

	it("rejects a subject with no type", () => {
		expect(validate("record a commit").conventionalOk).toBe(false);
	});

	it("measures the subject rather than judging it vaguely", () => {
		const long = `feat: ${"x".repeat(60)}`;

		expect(validate(long).subjectOk).toBe(false);
		expect(validate(long).subjectLength).toBe(66);
	});

	it("finds the longest body line and says which one it is", () => {
		const message = `${GOOD}\n\nshort\n${"y".repeat(80)}`;

		expect(validate(message).bodyWrapOk).toBe(false);
		expect(validate(message).bodyLongestLine).toBe(80);
		expect(validate(message).bodyLongestLineNum).toBe(4);
	});

	it("does not measure the subject as a body line", () => {
		expect(validate(GOOD).bodyLongestLine).toBe(0);
	});
});

// The complaints exist for the road with nobody watching. The guardian
// renders the same facts beside a panel, where a person is already
// deciding; a caller needs sentences it can act on without one.
describe("what it says to a caller with no panel", () => {
	it("names the measurement, not just the rule", () => {
		const long = `feat: ${"x".repeat(60)}`;

		expect(complaintsAbout(long)).toEqual([
			"the subject is 66 characters and the limit is 50",
		]);
	});

	it("points at the offending body line by number", () => {
		const message = `${GOOD}\n\nshort\n${"y".repeat(80)}`;

		expect(complaintsAbout(message)[0]).toBe(
			"body line 4 is 80 characters and the limit is 72",
		);
	});

	it("reports every complaint at once, not the first", () => {
		const message = `not conventional and also far too long to fit in fifty\n\n${"y".repeat(
			80,
		)}`;

		expect(complaintsAbout(message)).toHaveLength(3);
	});

	// The refusal gate forbids sending a reader off to a skill, so the
	// complaint has to carry the form itself.
	it("spells out conventional form rather than naming a skill", () => {
		const said = complaintsAbout("record a commit")[0] ?? "";

		expect(said).toContain("type(scope): subject");
		expect(said).not.toMatch(/\bskill\b/i);
	});
});
