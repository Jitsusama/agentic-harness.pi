import { describe, expect, it } from "vitest";
import {
	QUEST_CONTEXT,
	renderQuestContext,
} from "../../../extensions/quest-workflow/context.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";

function loaded(documentId?: string) {
	const state = createQuestState({ questsRoot: "/quests" });
	state.questId = "QEST-1";
	state.questKind = "quest";
	state.questStatus = "active";
	state.questPriority = "driving";
	state.questTitle = "Spend Less";
	if (documentId) {
		state.documentId = documentId;
		state.documentKind = "plan";
		state.documentStage = "build";
	}
	return state;
}

describe("renderQuestContext", () => {
	it("names the quest, its title and the focused document", () => {
		expect(renderQuestContext(loaded("PLAN-1"))).toBe(
			"Quest QEST-1 loaded (quest, active/driving). Title: Spend Less. Focused document: PLAN-1 (plan/build).",
		);
	});

	it("is nothing when no quest is loaded", () => {
		expect(
			renderQuestContext(createQuestState({ questsRoot: "/quests" })),
		).toBeNull();
	});
});

describe("QUEST_CONTEXT", () => {
	it("labels the line in the system prompt", () => {
		expect(QUEST_CONTEXT.inPrompt("Quest QEST-1 loaded.")).toBe(
			"\n\n[Quest workflow context] Quest QEST-1 loaded.",
		);
	});

	it("says a change supersedes the earlier context", () => {
		expect(QUEST_CONTEXT.changed("Quest QEST-1 loaded.")).toBe(
			"[Quest workflow context] Now: Quest QEST-1 loaded. This supersedes the quest context given earlier.",
		);
	});

	it("says so when the quest is unloaded", () => {
		expect(QUEST_CONTEXT.changed(null)).toContain("No quest is loaded.");
	});

	it("keeps the customType sessions already persist their ledger under", () => {
		expect(QUEST_CONTEXT.customType).toBe("quest-workflow-context");
	});
});
