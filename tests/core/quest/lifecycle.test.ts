/**
 * The loaded quest's slice of state: focusing and unfocusing a
 * document, the progress the widget paints, unloading, and the
 * Journey line a verb leaves behind.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendJourneyEntry,
	focusDocument,
	refreshLoadedSlice,
	refreshProgress,
	setQuestStatusByDir,
	stampQuestUpdated,
	unfocusDocument,
	unloadQuest,
} from "../../../lib/core/quest/lifecycle.ts";
import {
	LONG_AGO,
	loadIntoState,
	questOnDisk,
	seedDocument,
	seedQuest,
	useQuestsRoot,
} from "./support/quests.ts";

const state = useQuestsRoot();

const WORK = "\n# A Plan\n\n## Steps\n\n- [x] First\n- [ ] Second\n- [ ] Third\n";

describe("focusDocument", () => {
	it("asks for a quest when none is loaded", () => {
		expect(focusDocument(state(), "/nowhere.md")).toEqual({
			ok: false,
			guidance: "Load a quest first.",
		});
	});

	it("names the document it cannot read", () => {
		const s = state();
		loadIntoState(s, seedQuest(s, "A"));
		const missing = join(s.questsRoot, "missing.md");
		const focused = focusDocument(s, missing);
		expect(focused).toMatchObject({ ok: false });
		expect(focused.ok ? "" : focused.guidance).toContain(
			`Cannot read ${missing}`,
		);
	});

	it("says which field keeps a document from focusing", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const path = join(dir, "broken.md");
		writeFileSync(path, "---\nid: PLAN-1\nkind: plan\n---\n\n# Broken\n");
		const focused = focusDocument(s, path);
		expect(focused.ok ? "" : focused.guidance).toMatch(
			new RegExp(`^Cannot focus ${path}: .+\\.$`),
		);
		expect(s.documentPath).toBeNull();
	});

	it("holds the document's id, kind, title, stage and progress", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const path = seedDocument(dir, { stage: "build" }, WORK);
		expect(focusDocument(s, path)).toEqual({ ok: true });
		expect(s).toMatchObject({
			documentPath: path,
			documentKind: "plan",
			documentTitle: "A Plan",
			documentStage: "build",
			done: 1,
			total: 3,
			currentItem: "Second",
		});
		expect(s.documentId).toMatch(/^PLAN-/);
	});
});

describe("unfocusDocument", () => {
	it("clears the document and counts the README's work instead", () => {
		const s = state();
		const dir = seedQuest(s, "A", {}, "\n- [x] Done\n- [ ] Next\n");
		loadIntoState(s, dir);
		const path = seedDocument(dir, {}, WORK);
		focusDocument(s, path);
		unfocusDocument(s);
		expect(s).toMatchObject({
			documentPath: null,
			documentId: null,
			documentKind: null,
			documentTitle: null,
			documentStage: "idle",
			done: 1,
			total: 2,
			currentItem: "Next",
		});
	});
});

describe("refreshProgress", () => {
	it("counts nothing when no quest is loaded", () => {
		const s = state();
		s.done = 4;
		s.total = 9;
		s.currentItem = "Stale";
		refreshProgress(s);
		expect(s).toMatchObject({ done: 0, total: 0, currentItem: undefined });
	});

	it("falls back to the README when the focused document is gone", () => {
		const s = state();
		const dir = seedQuest(s, "A", {}, "\n- [ ] Only\n");
		loadIntoState(s, dir);
		s.documentPath = join(dir, "plans", "gone.md");
		refreshProgress(s);
		expect(s).toMatchObject({ done: 0, total: 1, currentItem: "Only" });
	});
});

describe("refreshLoadedSlice", () => {
	it("picks up a change made to the loaded quest's README", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		setQuestStatusByDir(dir, "paused");
		refreshLoadedSlice(s);
		expect(s).toMatchObject({ questTitle: "A", questStatus: "paused" });
	});

	it("leaves the slice alone when the README is gone", () => {
		const s = state();
		s.questDir = join(s.questsRoot, "gone");
		s.questTitle = "Kept";
		refreshLoadedSlice(s);
		expect(s.questTitle).toBe("Kept");
	});
});

describe("unloadQuest", () => {
	it("forgets the quest and its focused document", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		focusDocument(s, seedDocument(dir, {}, WORK));
		unloadQuest(s);
		expect(s).toMatchObject({
			questDir: null,
			questId: null,
			questTitle: null,
			questKind: null,
			questStatus: null,
			questPriority: null,
			documentPath: null,
			documentStage: "idle",
			done: 0,
			total: 0,
		});
	});
});

describe("appendJourneyEntry", () => {
	it("writes nothing when no quest is loaded", () => {
		expect(appendJourneyEntry(state(), "Did a thing.")).toBe(false);
	});

	it("adds the entry to the Journey and stamps the quest updated", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		expect(appendJourneyEntry(s, "Did a thing.")).toBe(true);
		expect(existsSync(join(dir, "JOURNEY.md"))).toBe(true);
		expect(questOnDisk(dir).updated).not.toBe(LONG_AGO);
	});
});

describe("stampQuestUpdated", () => {
	it("stamps the loaded quest updated and changes nothing else", () => {
		const s = state();
		const dir = seedQuest(s, "A", { rank: 3 });
		loadIntoState(s, dir);
		stampQuestUpdated(s);
		expect(questOnDisk(dir)).toMatchObject({ rank: 3, status: "active" });
		expect(questOnDisk(dir).updated).not.toBe(LONG_AGO);
	});
});
