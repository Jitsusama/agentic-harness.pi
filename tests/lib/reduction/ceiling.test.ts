import { describe, expect, it } from "vitest";
import { applyCeiling } from "../../../lib/reduction/index.js";

describe("applying an output ceiling", () => {
	it("leaves a result already within the ceiling untouched", () => {
		const result = applyCeiling("short result", 1000);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("short result");
		expect(result.originalChars).toBe(12);
	});

	it("truncates a result past the ceiling, to exactly the ceiling", () => {
		const text = "x".repeat(5000);
		const result = applyCeiling(text, 1000);
		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(1000);
		expect(result.originalChars).toBe(5000);
	});

	it("is exact at the boundary: equal to the ceiling is not truncated", () => {
		const text = "x".repeat(1000);
		const result = applyCeiling(text, 1000);
		expect(result.truncated).toBe(false);
		expect(result.text).toHaveLength(1000);
	});

	it("digests the full original text, not the truncated remainder", () => {
		const full = `${"a".repeat(2000)}TAIL`;
		const truncated = applyCeiling(full, 2000);
		const untouched = applyCeiling("a".repeat(2000), 2000);
		// Different original content must not collide on the digest just
		// because the visible, truncated prefix happens to match.
		expect(truncated.digest).not.toBe(untouched.digest);
	});

	it("gives an untruncated result no digest, since there is nothing held back to point at", () => {
		const result = applyCeiling("short result", 1000);
		expect(result.digest).toBeUndefined();
	});
});
