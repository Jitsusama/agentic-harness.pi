/**
 * Writing one field of a quest's front matter: by folder for any
 * quest, or on the loaded one, and its aliases a batch at a time.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addAliasesToQuest,
	removeAliasesFromQuest,
	setLoadedKind,
	setLoadedStatus,
	setQuestFieldByDir,
	setQuestParent,
	setQuestPriorityByDir,
	setQuestStatusByDir,
} from "../../../lib/core/quest/lifecycle.ts";
import { readJourneyFile } from "../../../lib/internal/quest/documents/journey.ts";
import { lensForField } from "../../../lib/internal/quest/fields/fields.ts";
import {
	LONG_AGO,
	loadIntoState,
	questOnDisk,
	seedQuest,
	useQuestsRoot,
} from "./support/quests.ts";

const state = useQuestsRoot();

const PR = { type: "github-pr", value: "o/r#1" };
const ISSUE = { type: "github-issue", value: "o/r#2" };

describe("by folder", () => {
	it("sets the status and the priority, stamping updated", () => {
		const dir = seedQuest(state(), "A");
		expect(setQuestStatusByDir(dir, "blocked")).toEqual({ ok: true });
		expect(setQuestPriorityByDir(dir, "bench")).toEqual({ ok: true });
		expect(questOnDisk(dir)).toMatchObject({
			status: "blocked",
			priority: "bench",
		});
		expect(questOnDisk(dir).updated).not.toBe(LONG_AGO);
	});

	it("sets the parent and says so in the Journey", () => {
		const s = state();
		const parent = questOnDisk(seedQuest(s, "Parent")).id;
		const dir = seedQuest(s, "Child");
		expect(setQuestParent(dir, parent)).toEqual({ ok: true });
		expect(questOnDisk(dir).parent).toBe(parent);
		expect(setQuestParent(dir, null)).toEqual({ ok: true });
		expect(questOnDisk(dir).parent).toBeNull();
		const journey = readJourneyFile(dir).join("\n");
		expect(journey).toContain(`Reparented to ${parent}.`);
		expect(journey).toContain("Reparented to top level.");
	});

	it("sets a field through its lens, refusing a word outside its vocabulary", () => {
		const dir = seedQuest(state(), "A");
		const status = lensForField("status");
		if (!status) throw new Error("status has no lens");
		expect(setQuestFieldByDir(dir, status, "paused")).toEqual({ ok: true });
		expect(questOnDisk(dir).status).toBe("paused");
		expect(setQuestFieldByDir(dir, status, "dormant")).toEqual({
			ok: false,
			guidance:
				"Cannot set status to dormant: it is not one of active, paused, blocked, concluded, retired.",
		});
		expect(questOnDisk(dir).status).toBe("paused");
	});

	it("refuses a folder with no README in it", () => {
		const empty = join(state().questsRoot, "empty");
		mkdirSync(empty, { recursive: true });
		expect(setQuestStatusByDir(empty, "paused")).toMatchObject({ ok: false });
	});
});

describe("aliases", () => {
	it("adds a batch once, reporting those already there", () => {
		const dir = seedQuest(state(), "A", { aliases: [PR] });
		expect(addAliasesToQuest(dir, [PR, ISSUE, ISSUE])).toEqual({
			ok: true,
			added: [ISSUE],
			already: [PR, ISSUE],
		});
		expect(questOnDisk(dir).aliases).toEqual([PR, ISSUE]);
	});

	it("removes a batch, reporting those that were absent", () => {
		const dir = seedQuest(state(), "A", { aliases: [PR, ISSUE] });
		const other = { type: "slack", value: "C1/1" };
		expect(removeAliasesFromQuest(dir, [PR, other])).toEqual({
			ok: true,
			removed: [PR],
			absent: [other],
		});
		expect(questOnDisk(dir).aliases).toEqual([ISSUE]);
	});

	it("writes nothing when none of the batch is there", () => {
		const dir = seedQuest(state(), "A");
		expect(removeAliasesFromQuest(dir, [PR])).toEqual({
			ok: true,
			removed: [],
			absent: [PR],
		});
		expect(questOnDisk(dir).updated).toBe(LONG_AGO);
	});
});

describe("on the loaded quest", () => {
	it("asks for a quest when none is loaded", () => {
		const refusal = { ok: false, guidance: "Load a quest first." };
		expect(setLoadedKind(state(), "sidequest")).toEqual(refusal);
		expect(setLoadedStatus(state(), "paused")).toEqual(refusal);
	});

	it("changes the kind, and lets a quest with a parent become a subquest", () => {
		const s = state();
		const parent = questOnDisk(seedQuest(s, "Parent")).id;
		const dir = seedQuest(s, "Child", { parent });
		loadIntoState(s, dir);
		expect(setLoadedKind(s, "subquest")).toEqual({ ok: true, changed: true });
		expect(setLoadedKind(s, "subquest")).toEqual({ ok: true, changed: false });
		expect(questOnDisk(dir).kind).toBe("subquest");
	});

	it("refuses a subquest with no parent to rank within", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		expect(setLoadedKind(s, "subquest")).toEqual({
			ok: false,
			guidance:
				"A subquest needs a parent to rank within; reparent it under a quest first.",
		});
		expect(questOnDisk(dir).kind).toBe("quest");
	});

	it("changes the status on disk and in state, once", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		expect(setLoadedStatus(s, "blocked")).toEqual({ ok: true, changed: true });
		expect(s.questStatus).toBe("blocked");
		expect(setLoadedStatus(s, "blocked")).toEqual({ ok: true, changed: false });
		expect(questOnDisk(dir).status).toBe("blocked");
	});
});
