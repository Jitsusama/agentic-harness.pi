/**
 * What the quests root holds, read across every quest: one quest by
 * id, all of them, and every working tree they record.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureQuestsRoot,
	findQuestEntry,
	inventoryWorktrees,
	listAllQuests,
} from "../../../lib/core/quest/lifecycle.ts";
import { questOnDisk, seedQuest, useQuestsRoot } from "./support/quests.ts";

const state = useQuestsRoot();

describe("findQuestEntry", () => {
	it("finds a quest by id and nothing for an id no quest has", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		const id = questOnDisk(dir).id;
		expect(findQuestEntry(s, id)?.dir).toBe(dir);
		expect(findQuestEntry(s, "QEST-20260101-NOSUCH")).toBeUndefined();
	});
});

describe("listAllQuests", () => {
	it("lists every quest under the root", () => {
		const s = state();
		const dirs = [seedQuest(s, "A"), seedQuest(s, "B")];
		expect(
			listAllQuests(s)
				.map((entry) => entry.dir)
				.sort(),
		).toEqual(dirs.sort());
	});
});

describe("inventoryWorktrees", () => {
	it("lists every quest's trees by path, saying which still exist", () => {
		const s = state();
		const here = join(s.questsRoot, "..", "tree-b");
		mkdirSync(here, { recursive: true });
		const gone = join(s.questsRoot, "..", "tree-a");
		const a = seedQuest(s, "A", {
			trees: [{ path: gone, branch: "feat/a", providerId: "git" }],
		});
		const b = seedQuest(s, "B", {
			trees: [{ path: here, providerId: "git" }],
		});
		const inventory = inventoryWorktrees(s);
		expect(inventory).toMatchObject([
			{
				path: gone,
				branch: "feat/a",
				questId: questOnDisk(a).id,
				questTitle: "A",
				exists: false,
			},
			{ path: here, questId: questOnDisk(b).id, questTitle: "B", exists: true },
		]);
		expect(inventory.map((entry) => "branch" in entry)).toEqual([true, false]);
	});
});

describe("ensureQuestsRoot", () => {
	it("makes the quests root when it is missing", () => {
		const s = state();
		expect(existsSync(s.questsRoot)).toBe(false);
		ensureQuestsRoot(s);
		expect(existsSync(s.questsRoot)).toBe(true);
		ensureQuestsRoot(s);
		expect(existsSync(s.questsRoot)).toBe(true);
	});
});
