import { describe, expect, it } from "vitest";
import { classifyReviewerError } from "../../../lib/subagent/reviewer-error.js";

// A reviewer's final turn can die for two very different
// reasons. A dropped or reset stream, a timeout or a 5xx is
// transient: the investigation is intact and resuming the
// session is cheap and likely to succeed. A missing
// credential, an unknown model or a bad thinking level is
// fatal: resuming would hit the same wall, so it must
// surface for the user to fix. Anything unrecognized is
// treated as fatal so a genuinely broken run never spins on
// a blind auto-resume.

describe("classifyReviewerError", () => {
	it("classifies a dropped or reset stream as transient", () => {
		expect(
			classifyReviewerError({
				stopReason: "error",
				message:
					"OpenAI Responses stream ended before a terminal response event",
			}),
		).toBe("transient");
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "read ECONNRESET",
			}),
		).toBe("transient");
	});

	it("classifies a 5xx or a rate limit as transient", () => {
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "503 Service Unavailable",
			}),
		).toBe("transient");
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "429 Too Many Requests: rate limit exceeded",
			}),
		).toBe("transient");
	});

	it("classifies a missing credential or unknown model as fatal", () => {
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "No API key found for openai",
			}),
		).toBe("fatal");
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "model gpt-9 does not exist",
			}),
		).toBe("fatal");
	});

	it("treats an unrecognized error as fatal", () => {
		expect(
			classifyReviewerError({
				stopReason: "error",
				message: "something nobody has seen before",
			}),
		).toBe("fatal");
	});
});
