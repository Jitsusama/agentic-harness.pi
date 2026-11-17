/**
 * The quest a session was on last, as its registry record says it: the
 * one it is on now, or once it has unloaded, the one it left latest.
 */

import { describe, expect, it } from "vitest";
import {
	openRecord,
	questLastOn,
	switchQuest,
} from "../../../../../lib/internal/quest/sessions/session-registry.ts";

const NOW = new Date("2026-07-28T18:00:00.000Z");
const LATER = new Date("2026-07-28T19:00:00.000Z");
const LATER_STILL = new Date("2026-07-28T20:00:00.000Z");

function opened(on: { questId?: string } = { questId: "QEST-1" }) {
	return openRecord({
		sessionId: "sess-1",
		instanceId: "inst-1",
		cwd: "/work",
		questId: on.questId,
		now: NOW,
	});
}

describe("questLastOn", () => {
	it("names the quest a session is on now", () => {
		expect(questLastOn(switchQuest(opened(), "QEST-2", LATER))).toBe("QEST-2");
	});

	it("names the quest it went back to and left last, once it unloads", () => {
		const away = switchQuest(opened(), "QEST-2", LATER);
		const back = switchQuest(away, "QEST-1", LATER_STILL);
		const gone = switchQuest(
			back,
			undefined,
			new Date("2026-07-28T21:00:00.000Z"),
		);
		expect(questLastOn(gone)).toBe("QEST-1");
	});

	it("names none for a session never on a quest, or left at no readable time", () => {
		const none = opened({});
		expect(questLastOn(none)).toBeUndefined();
		expect(
			questLastOn({ ...none, previousQuests: { "QEST-1": "soon" } }),
		).toBeUndefined();
	});
});
