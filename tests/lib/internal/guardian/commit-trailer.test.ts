import { describe, expect, it } from "vitest";
import {
	appendTrailerIfAbsent,
	coAuthorTrailer,
	formatModelName,
} from "../../../../lib/internal/guardian/commit-trailer.js";

const TRAILER = "Co-Authored-By: AI (Claude Opus 4.6 via Pi) <noreply@pi.dev>";

describe("appendTrailerIfAbsent", () => {
	it("appends the trailer after a blank line", () => {
		expect(appendTrailerIfAbsent("feat: x", TRAILER)).toBe(
			`feat: x\n\n${TRAILER}`,
		);
	});

	it("keeps exactly one blank line when the message ends with a newline", () => {
		expect(appendTrailerIfAbsent("feat: x\n", TRAILER)).toBe(
			`feat: x\n\n${TRAILER}`,
		);
	});

	it("returns null when the message already carries AI attribution", () => {
		const message = `feat: x\n\nCo-Authored-By: AI (Some Model) <noreply@pi.dev>`;
		expect(appendTrailerIfAbsent(message, TRAILER)).toBeNull();
	});
});

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
