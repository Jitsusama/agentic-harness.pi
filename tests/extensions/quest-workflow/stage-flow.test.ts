import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-stage-flow-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("document stage flow", () => {
	it("does not advance the stage in memory when the disk write fails", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Stage Flow",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "think",
			kind: "plan",
			note: "investigate",
		});
		await handle(state, fakePi(), fakeCtx(), {
			action: "draft",
			title: "Doc One",
		});
		expect(state.documentStage).toBe("draft");

		// Remove the document file so the stage write cannot persist.
		const docPath = state.documentPath as string;
		rmSync(docPath, { force: true });

		const built = await handle(state, fakePi(), fakeCtx(), {
			action: "build",
		});
		expect(built.ok).toBe(false);
		// Memory must not run ahead of a disk write that never happened.
		expect(state.documentStage).toBe("draft");
	});
});
