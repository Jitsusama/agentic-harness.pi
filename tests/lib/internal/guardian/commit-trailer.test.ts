import { describe, expect, it } from "vitest";
import {
	coAuthorTrailer,
	formatModelName,
} from "../../../../lib/internal/guardian/commit-trailer.js";

describe("coAuthorTrailer", () => {
	it("formats the model name and falls back without one", () => {
		expect(coAuthorTrailer("claude-opus-4-6-20250101")).toBe(
			"Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>",
		);
		expect(coAuthorTrailer(null)).toBe(
			"Co-Authored-By: AI via Pi <noreply@pi.dev>",
		);
	});
});

describe("formatModelName", () => {
	it("strips the date suffix and joins version digits", () => {
		expect(formatModelName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
		expect(formatModelName("claude-opus-4-6")).toBe("Claude Opus 4.6");
	});
});
