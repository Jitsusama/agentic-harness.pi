import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "conclude-by-id-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function questWithPlan() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const ctx = fakeCtx(tmpRoot);
	const created = await handle(state, fakePi(), ctx, {
		action: "create",
		title: "Code Stream",
	});
	if (!created.ok) throw new Error(created.guidance);
	await handle(state, fakePi(), ctx, {
		action: "think",
		kind: "plan",
		note: "Exploring",
	});
	await handle(state, fakePi(), ctx, { action: "draft", title: "First plan" });
	const planId = state.documentId ?? "";
	const questDir = state.questDir ?? "";
	// Unfocus so the conclude target is selected by id, not by focus.
	await handle(state, fakePi(), ctx, { action: "unfocus" });
	return { state, ctx, planId, questDir };
}

describe("conclude by document id", () => {
	it("concludes the named plan and leaves the quest active", async () => {
		const { state, ctx, planId, questDir } = await questWithPlan();
		const result = await handle(state, fakePi(), ctx, {
			action: "conclude",
			id: planId,
		});
		expect(result.ok).toBe(true);
		const planText = readFileSync(
			join(questDir, "plans", `${planId}.md`),
			"utf8",
		);
		expect(planText).toMatch(/stage:\s*concluded/);
		const readme = readFileSync(join(questDir, "README.md"), "utf8");
		expect(readme).toMatch(/status:\s*active/);
	});

	it("refuses a document id that does not exist under the quest", async () => {
		const { state, ctx } = await questWithPlan();
		const result = await handle(state, fakePi(), ctx, {
			action: "conclude",
			id: "PLAN-20260101-ZZZZZZ",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/not found/i);
	});

	it("refuses a crafted id that would escape the quest directory", async () => {
		const { state, ctx, questDir } = await questWithPlan();
		// A README exists one level up under quests/; a traversal id must
		// not reach it. The id keys to the plans subdir via its prefix.
		const result = await handle(state, fakePi(), ctx, {
			action: "conclude",
			id: "PLAN-/../../README",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/path separators/i);
		// The quest README is untouched: still active.
		expect(readFileSync(join(questDir, "README.md"), "utf8")).toMatch(
			/status:\s*active/,
		);
	});

	it("restores prior focus after concluding a sibling document by id", async () => {
		const { state, ctx, planId, questDir } = await questWithPlan();
		// Author a second plan and leave it focused, then conclude the
		// first plan by id: focus must return to the second plan, not
		// silently move to the one just concluded.
		await handle(state, fakePi(), ctx, {
			action: "think",
			kind: "plan",
			note: "Second",
		});
		await handle(state, fakePi(), ctx, {
			action: "draft",
			title: "Second plan",
		});
		const secondPath = state.documentPath;
		expect(secondPath).toBeTruthy();
		const result = await handle(state, fakePi(), ctx, {
			action: "conclude",
			id: planId,
		});
		expect(result.ok).toBe(true);
		expect(state.documentPath).toBe(secondPath);
		expect(
			readFileSync(join(questDir, "plans", `${planId}.md`), "utf8"),
		).toMatch(/stage:\s*concluded/);
	});
});
