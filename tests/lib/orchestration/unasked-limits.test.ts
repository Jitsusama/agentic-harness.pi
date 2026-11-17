/**
 * An orchestrator's limit on a verdict in the person's name, and the
 * sources that let it go.
 */

import { describe, expect, it } from "vitest";
import { limitsRefusal } from "../../../lib/orchestration/unasked-limits.ts";

describe("an orchestrator's limit on what is done in the person's name", () => {
	it("is refused when it narrows his verdict and cites no source", () => {
		// 16 November, 22:26: Joel said "I want it posted", and the review
		// cell was told this, which he never asked; at 22:29 he asked why.
		const refused = limitsRefusal(
			"Then post it on the PR, in Joel's name. Post no approval or block that Joel didn't ask for: a comment review.",
		);
		expect(refused).toContain(
			'"Post no approval or block that Joel didn\'t ask for: a comment review."',
		);
		for (const text of [
			"Only a comment review, never an approve.",
			"Don't request changes on it.",
			"Give it no approval, only a comment.",
		]) {
			expect(limitsRefusal(text), text).toBeDefined();
		}
	});

	it("goes when it quotes his words, names a message or names an owner's ruling", () => {
		for (const text of [
			'Post no approval, as Joel said at 22:29: "comment only on this one".',
			'Post no approval: "comment only on this one, no approve".',
			"Post no approval (his 1e97085d).",
			"Post no approval until LWKYKQ says the stack is clean.",
		]) {
			expect(limitsRefusal(text), text).toBeUndefined();
		}
	});

	it("goes when it bans publishing outright or keeps it a draft", () => {
		for (const text of [
			"Never post, approve or merge anything.",
			"Never post, approve or comment live, and never send Slack.",
			"Drafts only in Joel's name: never publish, post, approve, comment live, merge, push or send Slack.",
			"Draft the review with no approval; Joel will choose.",
		]) {
			expect(limitsRefusal(text), text).toBeUndefined();
		}
	});

	it("goes for limits on anything else, which the day's replay found sound", () => {
		for (const text of [
			"No router, modem or switch change without Joel's yes; reading is fine.",
			"Never on methuselah's Rosetta VM.",
			"A roster entry the host doesn't hold must never block a held restart for more than a minute.",
			"If nothing meets the bar, it is an approve with a one- or two-sentence body.",
			"approve if nothing must change before it merges, request changes if something must.",
			"No need to hold the merge for that answer.",
		]) {
			expect(limitsRefusal(text), text).toBeUndefined();
		}
	});
});
