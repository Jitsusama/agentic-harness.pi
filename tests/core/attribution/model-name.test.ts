import { describe, expect, it } from "vitest";
import { formatModelName } from "../../../lib/core/attribution/model-name.ts";

describe("formatModelName", () => {
	it("strips the date suffix and joins version digits", () => {
		expect(formatModelName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
		expect(formatModelName("claude-opus-4-6")).toBe("Claude Opus 4.6");
	});
});
