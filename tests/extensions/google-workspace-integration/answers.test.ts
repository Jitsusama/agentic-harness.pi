import { describe, expect, it } from "vitest";
import {
	missing,
	unconfirmed,
} from "../../../extensions/google-workspace-integration/router/answers.ts";
import { OUTCOME_GLYPH } from "../../../lib/ui/outcome-glyphs.ts";

/** An answer's words, for reading them in an expect. */
const words = (answer: { content: { text: string }[] } | undefined) =>
	answer?.content.map((part) => part.text).join("") ?? "";

describe("a call missing what it needs", () => {
	it("names the one parameter it lacks", () => {
		expect(words(missing("event_id"))).toBe(
			"Missing required parameter: event_id",
		);
	});

	it("names every parameter it lacks, as a list", () => {
		expect(words(missing("to", "subject", "body"))).toBe(
			"Missing required parameters: to, subject, body",
		);
	});
});

describe("a gate the person didn't pass", () => {
	it("says it was cancelled when they cancelled it", () => {
		expect(words(unconfirmed(null, "Delete cancelled"))).toBe(
			`${OUTCOME_GLYPH.cancelled} Delete cancelled`,
		);
	});

	it("passes on where they sent the agent instead", () => {
		expect(
			words(
				unconfirmed(
					{ approved: false, redirect: "ask Sam first" },
					"Delete cancelled",
				),
			),
		).toBe("ask Sam first");
	});
});
