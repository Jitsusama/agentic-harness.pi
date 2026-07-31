/**
 * What a failed provider command reports.
 *
 * The two streams carry different halves of one answer, and the useful half
 * was being discarded. `gh api` writes its own summary to stderr and the
 * server's response body to stdout, so preferring stderr turned a 422 that
 * named the exact offending field into `gh: Unprocessable Entity (HTTP 422)`:
 * a complete sentence about nothing.
 */

import { describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/review/providers/exec.js";
import { run } from "../../../lib/review/providers/exec.js";

/** An exec that fails with whatever the two streams should say. */
function failingWith(stderr: string, stdout: string): Exec {
	return async () => ({ code: 1, stdout, stderr });
}

describe("reporting a failed provider command", () => {
	it("keeps the field name the server sent, not only the summary", async () => {
		const exec = failingWith(
			"gh: Unprocessable Entity (HTTP 422)",
			'{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","field":"position","code":"missing_field"}]}',
		);

		await expect(run(exec, "gh", ["api"], "posting a review")).rejects.toThrow(
			/position/,
		);
	});

	it("keeps the summary too, since it names the status", async () => {
		const exec = failingWith(
			"gh: Unprocessable Entity (HTTP 422)",
			'{"errors":[{"field":"position"}]}',
		);

		await expect(run(exec, "gh", ["api"], "posting a review")).rejects.toThrow(
			/HTTP 422/,
		);
	});

	it("says what was being attempted", async () => {
		const exec = failingWith("boom", "");

		await expect(
			run(exec, "gh", ["api"], "posting a review on pull request 7"),
		).rejects.toThrow(/posting a review on pull request 7 failed/);
	});

	it("does not say the same words twice when both streams agree", async () => {
		const exec = failingWith("the same thing", "the same thing");

		const caught = await run(exec, "gh", ["api"], "asking")
			.then(() => undefined)
			.catch((error: Error) => error.message);

		expect(caught?.match(/the same thing/g)).toHaveLength(1);
	});

	it("still says something when both streams are empty", async () => {
		const exec = failingWith("", "");

		await expect(run(exec, "gs", ["pr", "view"], "reading")).rejects.toThrow(
			/gs exited nonzero/,
		);
	});

	it("caps a stream that carries real output rather than an error", async () => {
		// A command can fail after writing a whole diff, and a message nobody
		// will read to the end is its own kind of silence.
		const exec = failingWith("failed late", "x".repeat(9000));

		const caught = await run(exec, "git", ["diff"], "diffing")
			.then(() => undefined)
			.catch((error: Error) => error.message);

		expect(caught?.length).toBeLessThan(3000);
		expect(caught).toContain("failed late");
		expect(caught).toContain("\u2026");
	});
});
