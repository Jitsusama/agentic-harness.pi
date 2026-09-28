import { describe, expect, it } from "vitest";
import {
	classifyReviewerError,
	describeReviewerError,
	UNFINISHED,
} from "../../../lib/subagent/reviewer-error.ts";

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

// A child that exits 0 before its run ends had no provider error at all:
// what stopped it was the process, and resuming meets the same cause. The
// message names the tools that were running, which are anybody's words,
// so a tool that happens to sound transient must not make it one.
describe("an unfinished run", () => {
	const unfinished = {
		stopReason: UNFINISHED,
		message:
			"pi exited with code 0 while check_rate_limit was still running, before its run ended.",
	};

	it("is fatal whatever the running tool was called", () => {
		expect(classifyReviewerError(unfinished)).toBe("fatal");
	});

	it("is described as a run that stopped partway, not a bad setup", () => {
		const said = describeReviewerError(unfinished);

		expect(said).toContain("check_rate_limit");
		expect(said).toMatch(/before (it|its run) finished/);
		expect(said).not.toMatch(/credentials|model id|thinking level/);
	});
});
