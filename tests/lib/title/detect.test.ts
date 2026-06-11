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
		expect(
			detectTitleViolations("Fix: stop the crash").map((v) => v.issue),
		).toContain("conventional-commit");
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

	it("flags a title over 72 characters with the length and the limit", () => {
		const long =
			"Add a Very Long Descriptive Title That Goes Well Past the Seventy Two Character Limit";
		expect(long.length).toBeGreaterThan(72);
		const v = detectTitleViolations(long);
		expect(v).toContainEqual({
			kind: "title",
			issue: "over-length",
			found: `${long.length} characters (limit 72)`,
		});
	});

	it("leaves a title at exactly 72 characters alone", () => {
		const exactly72 = "A".repeat(72);
		expect(detectTitleViolations(exactly72)).toEqual([]);
	});

	it("leaves a short descriptive title under 50 chars alone", () => {
		expect(detectTitleViolations("Add Dark Mode Toggle")).toEqual([]);
	});

	it("flags a sentence-case title", () => {
		const v = detectTitleViolations(
			"Attribute replica memory to git subprocesses in Observe",
		);
		expect(v.map((x) => x.issue)).toContain("sentence-case");
	});

	it("flags an all-lowercase title", () => {
		expect(
			detectTitleViolations("rate limiting work").map((x) => x.issue),
		).toContain("sentence-case");
	});

	it("spares a Title Case title carrying one lowercase proper noun", () => {
		expect(
			detectTitleViolations(
				"Drive Non-Prod gitstream API and Secrets-Watch Off ExecStart Flags",
			),
		).toEqual([]);
	});

	it("spares lowercase proper nouns that do not outnumber capitalized words", () => {
		expect(
			detectTitleViolations("Integrate gsperf with gitstream Benchmarks"),
		).toEqual([]);
	});
});
