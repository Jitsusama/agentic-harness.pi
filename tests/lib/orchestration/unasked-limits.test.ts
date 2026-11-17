/**
 * An orchestrator's limit on a verdict in the person's name, and the
 * sources that let it go.
 */

import { describe, expect, it } from "vitest";
import { limitsRefusal } from "../../../lib/orchestration/unasked-limits.ts";

/** Each of `texts` refused, named by its own words when it isn't. */
function refusesEach(texts: string[]): void {
	for (const text of texts) {
		expect(limitsRefusal(text), text).toBeDefined();
	}
}

/** Each of `texts` let go, named by its own words when it isn't. */
function letsEachGo(texts: string[]): void {
	for (const text of texts) {
		expect(limitsRefusal(text), text).toBeUndefined();
	}
}

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
		refusesEach([
			"Only a comment review, never an approve.",
			"Don't request changes on it.",
			"Give it no approval, only a comment.",
		]);
	});

	it("is refused however the same limit is worded", () => {
		refusesEach([
			// A limit of its own ahead of it hides nothing.
			"No rush; post no approval or block.",
			// A short limit isn't a label to strip.
			"No approval or block: a comment review.",
			// Publishing it live keeps nothing a draft.
			"Post it live, no approval or block.",
			// Posting a verdict isn't a ban on posting.
			"Don't post an approval or block.",
			"Post it \u2014 no approval or block.",
			"Post it - no approval or block.",
			"Post it with no approval or block.",
			"Post the review, not an approval or block.",
			"Don\u2019t approve it.",
			"Post the review live, not a draft, with no approval.",
			// A draft pull request keeps no review a draft.
			"Post the review on the draft PR with no approval or block.",
			// A tag makes an order no question.
			"Post no approval or block, OK?",
			// Banning a merge isn't banning the review's posting.
			"Post the comment review, but don't merge or approve.",
			"Post **no** approval or block.",
			"Post nothing but a comment review.",
			"Comment review only.",
			"Approval: none; a comment review.",
			"Withhold approval; a comment review.",
			"Avoid approving it; a comment review.",
			"No approval is to be posted, only a comment.",
		]);
	});

	it("goes when it quotes his words, names a message, a rule or an owner's ruling", () => {
		letsEachGo([
			'Post no approval, as Joel said at 22:29: "comment only on this one".',
			'Post no approval: he said "comment only on this one, no approve".',
			"Post no approval (his 1e97085d).",
			"Post no approval until LWKYKQ says the stack is clean.",
			"Post no approval, by his standing rule on Delta.",
			"Post no approval, as AGENTS.md says of a stranger's change.",
			"Post no approval, as the review-guide skill says.",
		]);
	});

	it("is refused when what it cites is no source", () => {
		refusesEach([
			'Post no approval or block on "Fence a Mac Agent\'s Runs".',
			"Post no approval or block, as Joel asked.",
			"Post no approval or block; report to 85PKB2.",
			"Post no approval or block, per the review skill.",
			// His name anywhere doesn't make a quoted title his words.
			"In Joel's name, post no approval on \"Fence a Mac Agent's Runs\".",
			"Post no approval or block, by a standing rule.",
		]);
	});

	it("goes when it bans publishing outright or keeps it a draft", () => {
		letsEachGo([
			"Never post, approve or merge anything.",
			"Never post, approve or comment live, and never send Slack.",
			"Drafts only in Joel's name: never publish, post, approve, comment live, merge, push or send Slack.",
			"Draft the review with no approval; Joel will choose.",
			"Keep the review a draft, with no approval.",
		]);
	});

	it("goes for limits on anything else, which the day's replay found sound", () => {
		letsEachGo([
			"No router, modem or switch change without Joel's yes; reading is fine.",
			"Never on methuselah's Rosetta VM.",
			"A roster entry the host doesn't hold must never block a held restart for more than a minute.",
			"If nothing meets the bar, it is an approve with a one- or two-sentence body.",
			"approve if nothing must change before it merges, request changes if something must.",
			"No need to hold the merge for that answer.",
			"No blocking comments remain; approve it.",
			"No restart without Joel's approval.",
			"Don't block other sessions.",
			"There's no comment-only limit on this one.",
			"Why did you post no approval or block?",
			// Waiting on someone's approval, and review hygiene, narrow
			// nothing he decided.
			"Don't wait for my approval.",
			"Don't block on it; start the next task.",
			"Never approve a PR with failing CI.",
			"Don't approve if anything must change before it merges.",
			"Don't merge without Jon's approval.",
			"Don't post a verdict without reading the whole diff.",
			// 16 November, 23:30: a state, which the replay refused once.
			"The PR is blocked only by one outstanding finding.",
		]);
	});

	it("lets the correction of the 22:26 limit go", () => {
		// 03:28 UTC on 17 November, taking the limit back on his word.
		letsEachGo([
			'P9R1KI, correcting my 1e97085d. Joel at 22:29: "for jon\'s we can totally approve or block". So drop my "comment review only". Post the review in Joel\'s name with the verdict your review supports: approve if nothing must change before it merges, request changes if something must. Say which you chose and why in one line when you send the link.',
		]);
	});

	it("names no source in its refusal that would itself pass", () => {
		const refused = limitsRefusal("Post no approval or block.") ?? "";
		const advice = refused.split('block.").')[1] ?? "";
		expect(advice).toMatch(/quote his words/);
		expect(advice).not.toMatch(/\b[0-9A-Z]{6}\b|"|\b[0-9a-f]{8}\b/);
		// Copied into the limit, none of its words is a source.
		refusesEach(
			advice
				.split(/[.;:]\s*/)
				.filter(Boolean)
				.map((part) => `Post no approval or block, ${part}.`),
		);
	});
});
