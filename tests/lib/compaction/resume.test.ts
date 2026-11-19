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

		expect(owesResume(branch, T0 + 10_000)).toBe(true);
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

		expect(owesResume(branch, T0 + 10_000)).toBe(true);
	});

	it("owes nothing to a run stopped before an idle compaction was asked", () => {
		const branch = [
			answer(-60_000, "aborted"),
			asked(0, false),
			compaction(5000),
		];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("owes nothing once a message follows the compaction", () => {
		const branch = [asked(0, true), compaction(500), user(600)];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("is still owed past messages shown but never run", () => {
		const branch = [asked(0, true), compaction(500), mesh(2000)];

		expect(owesResume(branch, T0 + 10_000)).toBe(true);
	});

	it("owes nothing to a compaction nobody recorded asking for", () => {
		const branch = [answer(-2000, "toolUse"), toolResult(-1000), compaction(0)];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("owes nothing on an ask from before an earlier compaction", () => {
		const branch = [asked(0, true), compaction(500), compaction(9000)];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("owes nothing once the compaction is older than the window", () => {
		const branch = [asked(0, true), compaction(500)];

		expect(owesResume(branch, T0 + 500 + OWED_WITHIN_MS + 1)).toBe(false);
		expect(owesResume(branch, T0 + 500 + OWED_WITHIN_MS)).toBe(true);
	});

	it("owes nothing once the ask is settled after the compaction", () => {
		// The runtime that asked answered it, or one after it resumed.
		const branch = [asked(0, true), compaction(500), settled(600)];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("credits no later compaction with an ask its runtime settled", () => {
		// An ask whose compaction failed, then a /compact typed later.
		const branch = [asked(0, true), settled(4000), compaction(60_000)];

		expect(owesResume(branch, T0 + 70_000)).toBe(false);
	});

	it("credits no compaction landing long after an unsettled ask", () => {
		// An ask whose compaction failed in a runtime a reload replaced, so
		// nothing settled it, then a /compact typed twenty minutes on.
		const late = [asked(0, true), compaction(ASK_LANDS_WITHIN_MS + 1)];
		const onTime = [asked(0, true), compaction(ASK_LANDS_WITHIN_MS)];
		const now = T0 + ASK_LANDS_WITHIN_MS + 10_000;

		expect(owesResume(late, now)).toBe(false);
		expect(owesResume(onTime, now)).toBe(true);
	});

	it("owes nothing to a compaction stamped ahead of the clock", () => {
		const branch = [asked(0, true), compaction(5 * 60_000)];

		expect(owesResume(branch, T0)).toBe(false);
		expect(owesResume(branch, T0 + 5 * 60_000 - 30_000)).toBe(true);
	});

	it("owes nothing to a run stopped after the compaction landed", () => {
		// Escape after the landing is somebody stopping a run of their own.
		const branch = [
			asked(0, false),
			compaction(500),
			user(1000),
			answer(2000, "aborted"),
		];

		expect(owesResume(branch, T0 + 10_000)).toBe(false);
	});

	it("owes nothing with no compaction at all", () => {
		expect(owesResume([asked(0, true), answer(100, "aborted")], T0)).toBe(
			false,
		);
	});
});

describe("whether a run was cut since a moment", () => {
	it("counts a tool's result or a call for tools as cut", () => {
		expect(cutSince([toolResult(10)], T0)).toBe(true);
		expect(cutSince([answer(10, "toolUse")], T0)).toBe(true);
	});

	it("counts an answer that ended on its own as finished", () => {
		expect(cutSince([answer(10, "stop")], T0)).toBe(false);
		expect(cutSince([answer(10, "length")], T0)).toBe(false);
	});

	it("counts nothing written before the moment", () => {
		expect(cutSince([answer(-10, "aborted")], T0)).toBe(false);
	});

	it("looks past entries that hold no message", () => {
		expect(
			cutSince([answer(10, "aborted"), mesh(20), compaction(30)], T0),
		).toBe(true);
	});
});
