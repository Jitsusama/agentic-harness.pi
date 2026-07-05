import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linksForLoaded } from "../../../extensions/quest-workflow/lookup";
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
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-links-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("links projection", () => {
	it("lists only real quests, not mentioned document ids", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Target",
		});
		const targetId = state.questId as string;

		const home = buildState();
		await handle(home, fakePi(), fakeCtx(), {
			action: "create",
			kind: "quest",
			title: "Home",
		});
		const homeDir = home.questDir as string;

		// Mention the real quest and a document id that resolves to no
		// quest, the shape that used to render as a titleless quest.
		appendFileSync(
			join(homeDir, "README.md"),
			`\n\nSee ${targetId} and PLAN-20200101-AAAAAA for detail.\n`,
		);

		const links = linksForLoaded(home);
		const ids = links?.outgoing.quests.map((q) => q.id) ?? [];
		expect(ids).toContain(targetId);
		expect(ids).not.toContain("PLAN-20200101-AAAAAA");
	});
});
