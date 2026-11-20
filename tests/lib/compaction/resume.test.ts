/**
 * Whether a compaction left a run owed, read from the session's log.
 */

import { describe, expect, it } from "vitest";
import {
	ASK_LANDS_WITHIN_MS,
	ASKED_ENTRY,
	cutSince,
	OWED_WITHIN_MS,
	owesResume,
	SETTLED_ENTRY,
	unsettledAsk,
} from "../../../lib/compaction/resume.ts";

const T0 = Date.parse("2026-11-19T13:39:23.000Z");

function at(ms: number): string {
	return new Date(T0 + ms).toISOString();
}

function asked(ms: number, resume: boolean) {
	return {
		type: "custom",
		customType: ASKED_ENTRY,
		timestamp: at(ms),
		data: { at: T0 + ms, resume },
	};
}

function answer(ms: number, stopReason: string) {
	return {
		type: "message",
		timestamp: at(ms),
		message: { role: "assistant", stopReason, content: [] },
	};
}

function toolResult(ms: number) {
	return {
		type: "message",
		timestamp: at(ms),
		message: { role: "toolResult", content: [] },
	};
}

function user(ms: number) {
	return {
		type: "message",
		timestamp: at(ms),
		message: { role: "user", content: "go on" },
	};
}

function compaction(ms: number) {
	return { type: "compaction", timestamp: at(ms), summary: "s" };
}

function settled(ms: number) {
	return {
		type: "custom",
		customType: SETTLED_ENTRY,
		timestamp: at(ms),
		data: { at: T0 + ms, resumed: false, by: "asker" },
	};
}

function mesh(ms: number) {
	return { type: "custom_message", timestamp: at(ms), customType: "mesh" };
}

describe("whether a compaction left a run owed", () => {
	it("is owed when the turn that asked was going on", () => {
		const branch = [
			answer(-2000, "toolUse"),
			toolResult(-1000),
			asked(0, true),
			answer(100, "aborted"),
			compaction(500),
		];

		expect(
			owesResume(branch, T0 + 10_000),
			"a turn cut by its own ask is owed",
		).toBe(true);
	});

	it("is owed when a run begun after the ask was cut", () => {
		// 19 November, 13:39: a finished turn asked, a job's result started
		// a run a second later, and the compaction's abort cut it.
		const branch = [
			answer(-100, "stop"),
			asked(0, false),
			user(1000),
			answer(3000, "error"),
			compaction(8000),
		];

		expect(
			owesResume(branch, T0 + 10_000),
			"a run the compaction cut is owed",
		).toBe(true);
	});

	it("owes nothing to a run stopped before an idle compaction was asked", () => {
		const branch = [
			answer(-60_000, "aborted"),
			asked(0, false),
			compaction(5000),
		];

		expect(
			owesResume(branch, T0 + 10_000),
			"a run stopped before the ask owes nothing",
		).toBe(false);
	});

	it("owes nothing once a message follows the compaction", () => {
		const branch = [asked(0, true), compaction(500), user(600)];

		expect(owesResume(branch, T0 + 10_000), "a message settles it").toBe(false);
	});

	it("is still owed past messages shown but never run", () => {
		const branch = [asked(0, true), compaction(500), mesh(2000)];

		expect(
			owesResume(branch, T0 + 10_000),
			"a message shown but never run leaves it owed",
		).toBe(true);
	});

	it("owes nothing to a compaction nobody recorded asking for", () => {
		const branch = [answer(-2000, "toolUse"), toolResult(-1000), compaction(0)];

		expect(
			owesResume(branch, T0 + 10_000),
			"a compaction with no recorded ask owes nothing",
		).toBe(false);
	});

	it("owes nothing on an ask from before an earlier compaction", () => {
		const branch = [asked(0, true), compaction(500), compaction(9000)];

		expect(
			owesResume(branch, T0 + 10_000),
			"an earlier compaction's ask is not the later one's",
		).toBe(false);
	});

	it("owes nothing once the compaction is older than the window", () => {
		const branch = [asked(0, true), compaction(500)];

		expect(
			owesResume(branch, T0 + 500 + OWED_WITHIN_MS + 1),
			"past the window, nothing is owed",
		).toBe(false);
		expect(
			owesResume(branch, T0 + 500 + OWED_WITHIN_MS),
			"at the window's edge, it is owed",
		).toBe(true);
	});

	it("owes nothing once the ask is settled after the compaction", () => {
		// The runtime that asked answered it, or one after it resumed.
		const branch = [asked(0, true), compaction(500), settled(600)];

		expect(owesResume(branch, T0 + 10_000), "settling ends it").toBe(false);
	});

	it("credits no later compaction with an ask its runtime settled", () => {
		// An ask whose compaction failed, then a /compact typed later.
		const branch = [asked(0, true), settled(4000), compaction(60_000)];

		expect(
			owesResume(branch, T0 + 70_000),
			"a settled ask is no later compaction's",
		).toBe(false);
	});

	it("credits no compaction landing long after an unsettled ask", () => {
		// An ask whose compaction failed in a runtime a reload replaced, so
		// nothing settled it, then a /compact typed twenty minutes on.
		const late = [asked(0, true), compaction(ASK_LANDS_WITHIN_MS + 1)];
		const onTime = [asked(0, true), compaction(ASK_LANDS_WITHIN_MS)];
		const now = T0 + ASK_LANDS_WITHIN_MS + 10_000;

		expect(owesResume(late, now), "a late landing isn't the ask's").toBe(false);
		expect(owesResume(onTime, now), "a timely landing is the ask's").toBe(true);
	});

	it("owes nothing to a compaction stamped ahead of the clock", () => {
		const branch = [asked(0, true), compaction(5 * 60_000)];

		expect(
			owesResume(branch, T0),
			"a landing ahead of the clock owes nothing",
		).toBe(false);
		expect(
			owesResume(branch, T0 + 5 * 60_000 - 30_000),
			"within the clock's leeway, it is owed",
		).toBe(true);
	});

	it("owes nothing to a run stopped after the compaction landed", () => {
		// Escape after the landing is somebody stopping a run of their own.
		const branch = [
			asked(0, false),
			compaction(500),
			user(1000),
			answer(2000, "aborted"),
		];

		expect(
			owesResume(branch, T0 + 10_000),
			"a run stopped after the landing owes nothing",
		).toBe(false);
	});

	it("is owed when a run begun after the ask was cut before its first answer", () => {
		const branch = [asked(0, false), user(1000), compaction(8000)];

		expect(
			owesResume(branch, T0 + 10_000),
			"a run cut before its first answer is owed",
		).toBe(true);
	});

	it("is still owed past a tool's result logged after the landing", () => {
		// A tool the abort cut may write its result once the summary is in.
		const branch = [
			asked(0, true),
			answer(100, "aborted"),
			compaction(500),
			toolResult(600),
		];

		expect(
			owesResume(branch, T0 + 10_000),
			"a tool's late result leaves it owed",
		).toBe(true);
	});

	it("owes nothing on an ask it can't read", () => {
		const malformed = {
			...asked(0, true),
			data: { resume: true },
		};

		expect(
			owesResume([malformed, compaction(500)], T0 + 10_000),
			"an unreadable ask owes nothing",
		).toBe(false);
	});

	it("owes nothing when an earlier settle lies between the ask and the landing", () => {
		const branch = [asked(0, true), settled(200), compaction(500)];

		expect(
			owesResume(branch, T0 + 10_000),
			"an ask settled before the landing is not its",
		).toBe(false);
	});

	it("credits no compaction with an ask whose run has since finished", () => {
		// An ask nothing settled, then the person carried on and the run
		// ended on its own before a /compact of theirs landed.
		const going = [
			asked(0, true),
			user(60_000),
			answer(70_000, "stop"),
			compaction(120_000),
		];
		const idle = [
			asked(0, false),
			user(60_000),
			answer(70_000, "length"),
			user(80_000),
			compaction(120_000),
		];

		expect(owesResume(going, T0 + 130_000), "its own word").toBe(false);
		expect(owesResume(idle, T0 + 130_000), "a run since").toBe(false);
	});

	it("owes nothing with no compaction at all", () => {
		expect(
			owesResume([asked(0, true), answer(100, "aborted")], T0),
			"with no compaction, nothing is owed",
		).toBe(false);
	});
});

describe("the ask nothing has answered", () => {
	it("is the newest ask with no landing or settle after it", () => {
		const branch = [asked(0, false), user(1000), answer(2000, "aborted")];

		expect(unsettledAsk(branch, T0 + 60_000)).toEqual({
			at: T0,
			resume: false,
		});
	});

	it("is none once its compaction landed or it was settled", () => {
		const now = T0 + 60_000;
		expect(unsettledAsk([asked(0, true), compaction(500)], now)).toBe(
			undefined,
		);
		expect(unsettledAsk([asked(0, true), settled(500)], now)).toBe(undefined);
	});

	it("is none past the window an ask's compaction lands in", () => {
		const branch = [asked(0, true)];

		expect(unsettledAsk(branch, T0 + ASK_LANDS_WITHIN_MS + 1)).toBe(undefined);
		expect(unsettledAsk(branch, T0 + ASK_LANDS_WITHIN_MS)).toEqual({
			at: T0,
			resume: true,
		});
	});

	it("is none once a run after it has finished", () => {
		const branch = [asked(0, true), user(1000), answer(2000, "stop")];

		expect(unsettledAsk(branch, T0 + 60_000)).toBe(undefined);
	});

	it("reaches as far back as it is told", () => {
		const branch = [asked(0, true), answer(100, "aborted")];
		const now = T0 + ASK_LANDS_WITHIN_MS + 60_000;

		expect(unsettledAsk(branch, now)).toBe(undefined);
		expect(unsettledAsk(branch, now, OWED_WITHIN_MS)).toEqual({
			at: T0,
			resume: true,
		});
	});

	it("is none when it is stamped ahead of the clock, or malformed", () => {
		expect(unsettledAsk([asked(5 * 60_000, true)], T0)).toBe(undefined);
		expect(unsettledAsk([{ ...asked(0, true), data: {} }], T0)).toBe(undefined);
	});
});

describe("whether a run was cut since a moment", () => {
	it("counts a prompt with no answer after it as cut", () => {
		expect(cutSince([user(10)], T0), "an unanswered prompt is cut").toBe(true);
		expect(
			cutSince([user(10), answer(20, "stop")], T0),
			"an answered prompt is not",
		).toBe(false);
	});

	it("counts a tool's result or a call for tools as cut", () => {
		expect(cutSince([toolResult(10)], T0), "a tool's result is cut").toBe(true);
		expect(
			cutSince([answer(10, "toolUse")], T0),
			"a call for tools is cut",
		).toBe(true);
	});

	it("counts an answer that ended on its own as finished", () => {
		expect(
			cutSince([answer(10, "stop")], T0),
			"an answer that stopped is not",
		).toBe(false);
		expect(
			cutSince([answer(10, "length")], T0),
			"an answer that ran to length is not",
		).toBe(false);
	});

	it("counts nothing written before the moment", () => {
		expect(
			cutSince([answer(-10, "aborted")], T0),
			"a cut from before the moment is not counted",
		).toBe(false);
	});

	it("looks past entries that hold no message", () => {
		expect(
			cutSince([answer(10, "aborted"), mesh(20), compaction(30)], T0),
			"a cut behind entries with no message is counted",
		).toBe(true);
	});
});
