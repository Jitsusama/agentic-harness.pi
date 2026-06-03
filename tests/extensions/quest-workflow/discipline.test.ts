import { describe, expect, it } from "vitest";
import {
	enforceQuest,
	isFocusedDocWrite,
} from "../../../extensions/quest-workflow/enforce";
import type { QuestState } from "../../../extensions/quest-workflow/state";

function stateFixture(overrides: Partial<QuestState> = {}): QuestState {
	return {
		questsRoot: "/tmp/quests",
		questDir: "/tmp/quests/QEST-X",
		questId: "QEST-X",
		questTitle: "Test",
		questKind: "sidequest",
		questStatus: "active",
		questPriority: "active",
		documentPath: "/tmp/quests/QEST-X/plans/PLAN-Y.md",
		documentId: "PLAN-Y",
		documentKind: "plan",
		documentTitle: "Plan",
		documentStage: "draft",
		done: 0,
		total: 0,
		...overrides,
	};
}

describe("quest discipline", () => {
	it("blocks code writes while a plan is in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		const result = enforceQuest(
			state,
			"write",
			{ path: "/some/other/file.ts", content: "x" },
			"/tmp",
		);
		expect(result?.block).toBe(true);
	});

	it("allows writes to the focused plan document itself", () => {
		const state = stateFixture({ documentStage: "draft" });
		const path = state.documentPath ?? "";
		const result = enforceQuest(state, "write", { path, content: "..." }, "/");
		expect(result).toBeUndefined();
	});

	it("allows code writes when the plan is in build", () => {
		const state = stateFixture({ documentStage: "build" });
		const result = enforceQuest(
			state,
			"write",
			{ path: "/some/file.ts", content: "x" },
			"/tmp",
		);
		expect(result).toBeUndefined();
	});

	it("does not block when the focused doc is research, not plan", () => {
		const state = stateFixture({
			documentKind: "research",
			documentStage: "draft",
		});
		const result = enforceQuest(
			state,
			"write",
			{ path: "/file.ts", content: "x" },
			"/tmp",
		);
		expect(result).toBeUndefined();
	});

	it("blocks git-mutating bash commands during plan think/draft", () => {
		const state = stateFixture({ documentStage: "think" });
		const result = enforceQuest(
			state,
			"bash",
			{ command: "git commit -m foo" },
			"/tmp",
		);
		expect(result?.block).toBe(true);
	});

	it("isFocusedDocWrite recognises edits to the focused doc", () => {
		const state = stateFixture();
		const path = state.documentPath ?? "";
		expect(isFocusedDocWrite("edit", { path }, state.documentPath, "/")).toBe(
			true,
		);
		expect(
			isFocusedDocWrite(
				"write",
				{ path: "/somewhere/else.ts" },
				state.documentPath,
				"/tmp",
			),
		).toBe(false);
	});
});
