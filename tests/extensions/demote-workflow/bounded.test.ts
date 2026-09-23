import { cleanupSessionResults } from "@jitsusama/agentic-harness.core/result";
import { afterEach, describe, expect, it } from "vitest";
import { boundedExpansion } from "../../../extensions/demote-workflow/bounded.js";

describe("boundedExpansion", () => {
	afterEach(() => {
		cleanupSessionResults();
	});

	it("returns a short recovered result untouched", () => {
		const text = "a short bash result";
		expect(boundedExpansion(text, { digest: "abc123", found: true })).toBe(
			text,
		);
	});

	it("bounds a large recovered result and keeps the rest queryable by handle", () => {
		// A demoted result was large enough to be worth cutting in the
		// first place, so recovering it in full would just relocate the
		// same cost onto this call instead.
		const line = "line of demoted bash output with enough words on it\n";
		const text = line.repeat(5_000);

		const bounded = boundedExpansion(text, {
			digest: "deadbeef01234567",
			found: true,
		});

		expect(Buffer.byteLength(bounded, "utf-8")).toBeLessThan(
			Buffer.byteLength(text, "utf-8") / 5,
		);
		expect(bounded).toMatch(/handle result-[0-9a-f]{16}/);
	});
});
