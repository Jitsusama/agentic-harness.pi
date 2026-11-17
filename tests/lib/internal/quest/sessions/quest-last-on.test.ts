/**
 * The quest a session was on last, as its registry record says it, and
 * since when: the one it is on now, since it moved there, or once it
 * has unloaded, the one it left latest, as of leaving it.
 */

import { describe, expect, it } from "vitest";
import { questLastOn } from "../../../../../lib/internal/quest/sessions/quest-last-on.ts";
import {
	openRecord,
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
	it("names the quest a session opened on, since it opened", () => {
		expect(questLastOn(opened())).toEqual({
			quest: "QEST-1",
			at: NOW.toISOString(),
		});
	});

	it("names the quest a session is on now, since it moved there", () => {
		expect(questLastOn(switchQuest(opened(), "QEST-2", LATER))).toEqual({
			quest: "QEST-2",
			at: LATER.toISOString(),
		});
	});

	it("names the quest it went back to and left last, once it unloads", () => {
		const away = switchQuest(opened(), "QEST-2", LATER);
		const back = switchQuest(away, "QEST-1", LATER_STILL);
		const left = new Date("2026-07-28T21:00:00.000Z");
		expect(questLastOn(switchQuest(back, undefined, left))).toEqual({
			quest: "QEST-1",
			at: left.toISOString(),
		});
	});

	it("names the quest left latest, whatever order the record keeps them in", () => {
		const none = opened({});
		expect(
			questLastOn({
				...none,
				previousQuests: {
					"QEST-3": "2026-07-28T21:00:00.000Z",
					"QEST-1": "2026-07-28T19:00:00.000Z",
				},
			}),
		).toEqual({ quest: "QEST-3", at: "2026-07-28T21:00:00.000Z" });
	});

	it("names none for a session never on a quest, or left at no readable time", () => {
		const none = opened({});
		expect(questLastOn(none)).toBeUndefined();
		expect(
			questLastOn({ ...none, previousQuests: { "QEST-1": "soon" } }),
		).toBeUndefined();
	});
});
