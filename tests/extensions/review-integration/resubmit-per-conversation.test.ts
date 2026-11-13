/**
 * A refused proposal is remembered by the conversation it was refused
 * in: in a host, whose conversations share this module across folders,
 * another conversation is neither told its text was refused before nor
 * filled from someone else's draft of the same checkout and branch.
 */

import { describe, expect, it } from "vitest";
import {
	draftKey,
	filledFromRefused,
	keepRefusedDraft,
	sayRefusal,
} from "../../../extensions/review-integration/tools/resubmit.ts";

const sections = {
	tldr: "What changed.",
	problem: "Why.",
	solution: "How.",
	validation: "What ran.",
};

describe("remembering refusals per conversation", () => {
	it("says a refusal is a repeat only in the conversation that made it", () => {
		sayRefusal("a", "the complaint", "Title", "repeat body");

		expect(sayRefusal("a", "the complaint", "Title", "repeat body")).toContain(
			"word for word",
		);
		expect(sayRefusal("b", "the complaint", "Title", "repeat body")).toBe(
			"the complaint",
		);
	});

	it("fills a resubmit only from its own conversation's refused draft", () => {
		keepRefusedDraft(draftKey("a", "/repo", "topic"), "A Title", sections);

		expect(
			filledFromRefused(draftKey("a", "/repo", "topic"), undefined, {})?.title,
		).toBe("A Title");
		expect(
			filledFromRefused(draftKey("b", "/repo", "topic"), undefined, {}),
		).toBeUndefined();
	});
});
