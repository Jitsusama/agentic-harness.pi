/**
 * Coming back to a change you already reviewed.
 *
 * The standing that matters is the one where a thread says settled and nothing
 * supports that, because in a thread listing it looks exactly like a thread
 * somebody fixed. Everything else here exists to make sure that one is not
 * over-reported: a standing that fires on threads which were genuinely answered
 * would be ignored within a day.
 */

import { describe, expect, it } from "vitest";
import type { Actor } from "../../../lib/review/change.js";
import type { Thread } from "../../../lib/review/conversation.js";
import {
	followUpOn,
	receptionOf,
	tallyReceptions,
} from "../../../lib/review/followup.js";

const ME: Actor = { id: "jitsusama", name: "Joel" };
const THEM: Actor = { id: "someone", name: "Someone Else" };

/** A thread with the comments named by who wrote them. */
function thread(authors: readonly Actor[], rest: Partial<Thread> = {}): Thread {
	return {
		id: "t1",
		resolved: false,
		comments: authors.map((author, at) => ({
			id: `c${at}`,
			author,
			body: `remark ${at}`,
		})),
		...rest,
	};
}

describe("where one of my threads stands", () => {
	it("reports a reply after my remark as answered", () => {
		// The strongest signal: somebody wrote words aimed at the remark.
		const one = thread([ME, THEM], { stale: false });

		expect(receptionOf(one, ME)).toBe("answered");
	});

	it("does not count my own follow-up as an answer", () => {
		// Otherwise adding a nudge to my own thread marks it answered by me.
		const one = thread([ME, ME], { stale: false });

		expect(receptionOf(one, ME)).toBe("waiting");
	});

	it("reports a moved anchor as changed, even with nobody replying", () => {
		const one = thread([ME], { stale: true });

		expect(receptionOf(one, ME)).toBe("changed");
	});

	it("reports a thread closed with no reply and no movement", () => {
		// The one worth looking at, and the reason this exists.
		const one = thread([ME], { stale: false, resolved: true });

		expect(receptionOf(one, ME)).toBe("resolved-in-silence");
	});

	it("names who closed it, when the backend says", () => {
		const closed = thread([ME], {
			stale: false,
			resolved: true,
			resolvedBy: THEM,
		});

		const [found] = followUpOn([closed], ME);
		expect(found.because).toContain("Someone Else");
	});

	it("reports an open thread nothing has happened to as waiting", () => {
		const one = thread([ME], { stale: false });

		expect(receptionOf(one, ME)).toBe("waiting");
	});

	it("keeps 'cannot tell' apart from 'nothing happened'", () => {
		// Merging them would let a backend that reports less look like a change
		// that moved less.
		const silent = thread([ME], { resolved: true });

		expect(silent.stale).toBeUndefined();
		expect(receptionOf(silent, ME)).toBe("unknown");
	});

	it("prefers a reply over a moved anchor", () => {
		// Both are true here. The reply is what a person needs to read.
		const one = thread([ME, THEM], { stale: true });

		expect(receptionOf(one, ME)).toBe("answered");
	});

	it("identifies me by id, never by display name", () => {
		// Two people share a display name, and one person changes theirs.
		const impostor: Actor = { id: "other", name: "Joel" };
		const one = thread([impostor], { stale: false });

		expect(receptionOf(one, ME)).toBe("unknown");
	});
});

describe("my threads on a change", () => {
	it("leaves out threads I never spoke in", () => {
		// Somebody else's conversation belongs to the audit round instead.
		const found = followUpOn(
			[thread([THEM], { stale: false }), thread([ME], { stale: false })],
			ME,
		);

		expect(found).toHaveLength(1);
	});

	it("puts what needs attention first", () => {
		const found = followUpOn(
			[
				thread([ME, THEM], { stale: false }),
				thread([ME], { stale: false }),
				thread([ME], { stale: false, resolved: true }),
			],
			ME,
		);

		expect(found.map((one) => one.reception)).toEqual([
			"resolved-in-silence",
			"waiting",
			"answered",
		]);
	});

	it("counts each standing for a summary line", () => {
		const found = followUpOn(
			[
				thread([ME], { stale: false, resolved: true }),
				thread([ME], { stale: false, resolved: true }),
				thread([ME], { stale: true }),
			],
			ME,
		);

		expect(tallyReceptions(found)).toEqual({
			"resolved-in-silence": 2,
			changed: 1,
		});
	});

	it("says nothing about a change I never remarked on", () => {
		expect(followUpOn([thread([THEM])], ME)).toEqual([]);
	});
});
