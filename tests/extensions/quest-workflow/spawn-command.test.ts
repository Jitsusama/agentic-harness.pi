import { describe, expect, it } from "vitest";
import {
	resolveSpawnCommand,
	resumeMessage,
} from "../../../extensions/quest-workflow/verbs/session";
import {
	formatRelativeAge,
	type SessionView,
} from "../../../lib/internal/quest/session-liveness";

function view(
	id: string,
	liveness: SessionView["liveness"],
	lastActivity?: string,
): SessionView {
	return { id, status: "active", liveness, lastActivity };
}

const now = new Date("2026-06-19T12:00:00.000Z");

describe("resolveSpawnCommand", () => {
	it("resumes the single picked session with pi --session", () => {
		expect(resolveSpawnCommand(undefined, { id: "019abc" })).toEqual({
			command: "pi --session 019abc",
			resumedSessionId: "019abc",
		});
	});

	it("starts a fresh pi when no session is resumable", () => {
		expect(resolveSpawnCommand(undefined, undefined)).toEqual({
			command: "pi",
		});
	});

	it("starts a fresh pi when the pick is ambiguous", () => {
		expect(resolveSpawnCommand(undefined, { ambiguous: [] })).toEqual({
			command: "pi",
		});
	});

	it("lets an explicit command win over a resumable session", () => {
		expect(resolveSpawnCommand("pi --model x", { id: "019abc" })).toEqual({
			command: "pi --model x",
		});
	});
});

describe("formatRelativeAge", () => {
	it("returns undefined without a timestamp", () => {
		expect(formatRelativeAge(undefined, now)).toBeUndefined();
	});

	it("returns undefined for an unparseable timestamp", () => {
		expect(formatRelativeAge("not-a-date", now)).toBeUndefined();
	});

	it("reads recent activity as just now", () => {
		expect(formatRelativeAge("2026-06-19T11:59:30.000Z", now)).toBe("just now");
	});

	it("reports minutes, hours and days", () => {
		expect(formatRelativeAge("2026-06-19T11:45:00.000Z", now)).toBe("15m ago");
		expect(formatRelativeAge("2026-06-19T09:00:00.000Z", now)).toBe("3h ago");
		expect(formatRelativeAge("2026-06-17T12:00:00.000Z", now)).toBe("2d ago");
	});
});

describe("resumeMessage", () => {
	it("is undefined when nothing resumes", () => {
		expect(resumeMessage(undefined, [], now)).toBeUndefined();
	});

	it("names a live resume plainly", () => {
		const sessions = [view("019live", "live", "2026-06-19T11:59:00.000Z")];
		expect(resumeMessage({ id: "019live" }, sessions, now)).toBe(
			"Resuming session 019live.",
		);
	});

	it("flags an idle resume with its last-active age", () => {
		const sessions = [view("019idle", "idle", "2026-06-17T12:00:00.000Z")];
		expect(resumeMessage({ id: "019idle" }, sessions, now)).toBe(
			"Resuming idle session 019idle, last active 2d ago.",
		);
	});

	it("omits the age clause for an idle session with no recorded activity", () => {
		const sessions = [view("019idle", "idle")];
		expect(resumeMessage({ id: "019idle" }, sessions, now)).toBe(
			"Resuming idle session 019idle.",
		);
	});

	it("reports the count when the pick is ambiguous", () => {
		const sessions = [view("a", "live"), view("b", "live")];
		expect(resumeMessage({ ambiguous: sessions }, sessions, now)).toBe(
			"2 live sessions; started fresh, resume one explicitly if needed.",
		);
	});
});
