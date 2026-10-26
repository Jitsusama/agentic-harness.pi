import { describe, expect, it } from "vitest";
import { QUEST_ACTIONS } from "../../../extensions/quest-workflow/actions.ts";
import { withRenamedAction } from "../../../extensions/quest-workflow/renames.ts";

describe("a renamed quest action", () => {
	it("is taken under its new name when called by the old", () => {
		expect(withRenamedAction({ action: "tree-prune", cwd: "/x" })).toEqual({
			action: "tree-release",
			cwd: "/x",
		});
	});

	it("takes `workspace` as `sessions`, leaving workspace to niri", () => {
		expect(withRenamedAction({ action: "workspace" })).toEqual({
			action: "sessions",
		});
	});

	it("is offered only under its new name", () => {
		expect(QUEST_ACTIONS).toContain("tree-release");
		expect(QUEST_ACTIONS).not.toContain("tree-prune");
		expect(QUEST_ACTIONS).toContain("sessions");
		expect(QUEST_ACTIONS).not.toContain("workspace");
	});

	it("leaves every other call as it was", () => {
		const call = { action: "tree-list" };
		expect(withRenamedAction(call)).toBe(call);
		expect(withRenamedAction("tree-prune")).toBe("tree-prune");
		expect(withRenamedAction({ action: 3 })).toEqual({ action: 3 });
	});
});
