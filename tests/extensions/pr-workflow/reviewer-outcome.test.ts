import { describe, expect, it } from "vitest";
import { reviewerFailureBanner } from "../../../extensions/pr-workflow/reviewer-outcome.js";

// A council/review run where every reviewer crashed used to
// render "findings are ready" with the real story buried in
// a warnings block, so the failure read as success. The
// banner turns an all-failed run into a loud, named failure
// at the top of the summary. It stays silent whenever at
// least one reviewer verified, so a partial run is not
// maligned.

describe("reviewerFailureBanner", () => {
	it("returns null when at least one reviewer verified", () => {
		const banner = reviewerFailureBanner([
			{ verification: { called: true, ok: true }, warnings: [] },
			{ verification: { called: true, ok: false }, warnings: ["boom"] },
		]);
		expect(banner).toBeNull();
	});

	it("returns null for an empty roster", () => {
		expect(reviewerFailureBanner([])).toBeNull();
	});

	it("names a spawn crash when every reviewer died at spawn", () => {
		const banner = reviewerFailureBanner([
			{
				verification: { called: false, ok: false },
				warnings: ["Pi subprocess exited non-zero (exit 1)"],
			},
			{
				verification: { called: false, ok: false },
				warnings: ["Pi stderr: node:internal/child_process:420"],
			},
		]);
		expect(banner).not.toBeNull();
		expect(banner).toContain("0 of 2");
		expect(banner?.toLowerCase()).toContain("spawn");
	});

	it("names verify_output when every reviewer ended without verifying", () => {
		const banner = reviewerFailureBanner([
			{ verification: { called: false, ok: false }, warnings: [] },
			{ verification: { called: false, ok: false }, warnings: [] },
		]);
		expect(banner).not.toBeNull();
		expect(banner).toContain("0 of 2");
		expect(banner).toContain("verify_output");
	});
});
