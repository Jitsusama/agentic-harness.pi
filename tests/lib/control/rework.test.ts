import { describe, expect, it } from "vitest";
import { classifyRepeats } from "../../../lib/control/index.js";

function call(argsDigest: string, isVerify = false) {
	return { argsDigest, isVerify };
}

describe("classifying a repeated call as appraisal or rework", () => {
	it("classifies a repeat with no verify in between as rework", () => {
		const occurrences = [call("d1"), call("d1")];
		const classified = classifyRepeats(occurrences);
		expect(classified).toHaveLength(1);
		expect(classified[0].classification).toBe("rework");
	});

	it("classifies a repeat with a verify in between as appraisal, not waste", () => {
		// A verification pass re-reading a file to confirm a fix landed is
		// cost-of-quality, not the same repeat as just asking twice.
		const occurrences = [call("d1"), call("build", true), call("d1")];
		const classified = classifyRepeats(occurrences);
		expect(classified).toHaveLength(1);
		expect(classified[0].classification).toBe("appraisal");
	});

	it("does not classify the first occurrence of anything, only its repeats", () => {
		const occurrences = [call("d1"), call("d2"), call("d3")];
		expect(classifyRepeats(occurrences)).toEqual([]);
	});

	it("classifies each repeat past the first independently against the nearest verify", () => {
		const occurrences = [
			call("d1"), // first
			call("d1"), // repeat 1: no verify since first -> rework
			call("build", true),
			call("d1"), // repeat 2: verify happened since repeat 1 -> appraisal
			call("d1"), // repeat 3: no verify since repeat 2 -> rework
		];
		const classified = classifyRepeats(occurrences);
		expect(classified.map((c) => c.classification)).toEqual([
			"rework",
			"appraisal",
			"rework",
		]);
	});

	it("does not let a verify call for a different reason cross into an unrelated digest's classification incorrectly", () => {
		// Two independently repeated digests, one with a verify between its
		// own repeats and one without, must not bleed into each other.
		const occurrences = [
			call("d1"),
			call("d2"),
			call("build", true),
			call("d2"), // verify happened since d2's first occurrence -> appraisal
			call("d1"), // no verify since d1's first occurrence... wait, build happened, but before d1's repeat too
		];
		const classified = classifyRepeats(occurrences);
		const d2 = classified.find((c) => c.argsDigest === "d2");
		expect(d2?.classification).toBe("appraisal");
	});
});
