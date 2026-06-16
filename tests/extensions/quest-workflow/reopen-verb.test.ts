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
	tmpRoot = mkdtempSync(join(tmpdir(), "reopen-verb-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function activeQuest() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const ctx = fakeCtx(tmpRoot);
	const created = await handle(state, fakePi(), ctx, {
		action: "create",
		title: "Resuscitate Me",
	});
	if (!created.ok) throw new Error(created.guidance);
	return { state, ctx };
}

describe("reopen", () => {
	it("returns a concluded quest to active", async () => {
		const { state, ctx } = await activeQuest();
		await handle(state, fakePi(), ctx, { action: "conclude" });
		const result = await handle(state, fakePi(), ctx, { action: "reopen" });
		expect(result.ok).toBe(true);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme).toMatch(/status:\s*active/);
	});

	it("refuses to reopen a quest that is already active", async () => {
		const { state, ctx } = await activeQuest();
		const result = await handle(state, fakePi(), ctx, { action: "reopen" });
		expect(result.ok).toBe(false);
	});
});
