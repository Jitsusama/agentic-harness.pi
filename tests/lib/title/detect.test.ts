import { describe, expect, it } from "vitest";
import { detectTitleViolations } from "../../../lib/title/index.js";

describe("detectTitleViolations", () => {
	it("passes a descriptive Title Case title", () => {
		expect(
			detectTitleViolations("Add Rate Limiting to Prevent API Abuse"),
		).toEqual([]);
	});

	it("flags a conventional-commit title with scope", () => {
		const v = detectTitleViolations(
			"chore(monitoring): define gitstream notification policies as code",
		);
		expect(v).toContainEqual({
			kind: "title",
			issue: "conventional-commit",
			found: "chore(monitoring):",
		});
	});

	it("flags a bare conventional-commit type", () => {
		expect(detectTitleViolations("feat: add the thing")[0]?.issue).toBe(
			"conventional-commit",
		);
	});

	it("flags a capitalized conventional-commit prefix", () => {
		expect(detectTitleViolations("Fix: stop the crash")).toHaveLength(1);
	});

	it("flags a breaking-change marker prefix", () => {
		expect(detectTitleViolations("feat!: drop the old API")[0]?.found).toBe(
			"feat!:",
		);
	});

	it("leaves a descriptive title with a non-type colon prefix alone", () => {
		expect(
			detectTitleViolations("Gitstream: Bring Policies Under Code Review"),
		).toEqual([]);
	});

	it("does not treat a type word followed by a space as conventional commit", () => {
		expect(detectTitleViolations("Fix the Flaky Push Test")).toEqual([]);
	});
});
