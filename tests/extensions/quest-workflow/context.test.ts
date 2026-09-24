import { describe, expect, it } from "vitest";
import {
	afterCompaction,
	type QuestContextLedger,
	questContextTurn,
	renderQuestContext,
} from "../../../extensions/quest-workflow/context.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";

const BASE = "You are pi.";

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

describe("questContextTurn", () => {
	it("puts the context in the system prompt on the first turn", () => {
		const turn = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		expect(turn.systemPrompt).toBe(
			`${BASE}\n\n[Quest workflow context] Quest QEST-1 loaded.`,
		);
		expect(turn.message).toBeUndefined();
	});

	it("keeps the system prompt byte-identical when the quest state changes", () => {
		const first = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		const later = questContextTurn(
			first.ledger,
			"Quest QEST-1 loaded. Focused document: PLAN-1 (plan/build).",
			BASE,
		);
		expect(later.systemPrompt).toBe(first.systemPrompt);
	});

	it("says what changed once, in a message that supersedes the prompt", () => {
		const first = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		const current =
			"Quest QEST-1 loaded. Focused document: PLAN-1 (plan/build).";
		const later = questContextTurn(first.ledger, current, BASE);
		expect(later.message?.customType).toBe("quest-workflow-context");
		expect(later.message?.display).toBe(false);
		expect(later.message?.content).toContain(current);
		expect(later.message?.content).toContain("supersedes");
		const again = questContextTurn(later.ledger, current, BASE);
		expect(again.message).toBeUndefined();
	});

	it("says so when the quest is unloaded, keeping the frozen line", () => {
		const first = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		const later = questContextTurn(first.ledger, null, BASE);
		expect(later.systemPrompt).toBe(first.systemPrompt);
		expect(later.message?.content).toContain("No quest is loaded");
	});

	it("leaves the prompt alone and sends a message for a quest loaded mid-session", () => {
		const first = questContextTurn({}, null, BASE);
		expect(first.systemPrompt).toBe(BASE);
		const later = questContextTurn(first.ledger, "Quest QEST-1 loaded.", BASE);
		expect(later.systemPrompt).toBe(BASE);
		expect(later.message?.content).toContain("Quest QEST-1 loaded.");
	});

	it("sends the current context again after a compaction summarised the message away", () => {
		const first = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		const current =
			"Quest QEST-1 loaded. Focused document: PLAN-1 (plan/build).";
		const told = questContextTurn(first.ledger, current, BASE);
		const compacted: QuestContextLedger = afterCompaction(told.ledger);
		const after = questContextTurn(compacted, current, BASE);
		expect(after.systemPrompt).toBe(first.systemPrompt);
		expect(after.message?.content).toContain(current);
	});

	it("sends nothing after a compaction when the state is still the frozen one", () => {
		const first = questContextTurn({}, "Quest QEST-1 loaded.", BASE);
		const after = questContextTurn(
			afterCompaction(first.ledger),
			"Quest QEST-1 loaded.",
			BASE,
		);
		expect(after.message).toBeUndefined();
	});
});
