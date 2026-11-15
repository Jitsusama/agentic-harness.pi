/**
 * A quest's place among its siblings: the quests sharing its parent
 * and priority, reordered and written back rank by rank.
 */

import { describe, expect, it } from "vitest";
import {
	reorderSiblings,
	setQuestRankByDir,
} from "../../../lib/core/quest/lifecycle.ts";
import { questOnDisk, seedQuest, useQuestsRoot } from "./support/quests.ts";

const state = useQuestsRoot();

describe("reorderSiblings", () => {
	it("refuses an id no quest has", () => {
		const s = state();
		expect(reorderSiblings(s, "QEST-20260101-NOSUCH", { kind: "top" })).toEqual({
			ok: false,
			guidance: `No quest with id "QEST-20260101-NOSUCH" under ${s.questsRoot}.`,
		});
	});

	it("refuses a sealed quest until it is reopened", () => {
		const s = state();
		const id = questOnDisk(seedQuest(s, "A", { status: "concluded" })).id;
		expect(reorderSiblings(s, id, { kind: "top" })).toEqual({
			ok: false,
			guidance: `Quest "${id}" is concluded; reopen it before reordering.`,
		});
	});

	it("moves a quest to the top of quests sharing its parent and priority", () => {
		const s = state();
		const first = seedQuest(s, "First", { rank: 1 });
		const second = seedQuest(s, "Second", { rank: 2 });
		const third = seedQuest(s, "Third", { rank: 3 });
		const queued = seedQuest(s, "Queued", { rank: 1, priority: "queued" });
		const sealed = seedQuest(s, "Sealed", { rank: 1, status: "retired" });
		const id = questOnDisk(third).id;
		const moved = reorderSiblings(s, id, { kind: "top" });
		expect(moved).toMatchObject({ ok: true });
		if (!moved.ok) return;
		expect(moved.result.siblings).toHaveLength(3);
		expect(moved.result.changes).toContainEqual({ id, from: 3, to: 1 });
		expect([first, second, third, queued, sealed].map((d) => questOnDisk(d).rank)).toEqual([
			2, 3, 1, 1, 1,
		]);
	});

	it("puts a quest after the one it names", () => {
		const s = state();
		const first = seedQuest(s, "First", { rank: 1 });
		const second = seedQuest(s, "Second", { rank: 2 });
		const third = seedQuest(s, "Third", { rank: 3 });
		const moved = reorderSiblings(s, questOnDisk(first).id, {
			kind: "after",
			target: questOnDisk(second).id,
		});
		expect(moved).toMatchObject({ ok: true });
		expect([first, second, third].map((d) => questOnDisk(d).rank)).toEqual([
			2, 1, 3,
		]);
	});
});

describe("setQuestRankByDir", () => {
	it("writes the rank", () => {
		const s = state();
		const dir = seedQuest(s, "A", { rank: 1 });
		expect(setQuestRankByDir(dir, 7)).toEqual({ ok: true });
		expect(questOnDisk(dir).rank).toBe(7);
	});
});
