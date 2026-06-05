import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshLoadedSlice } from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-refresh-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("refreshLoadedSlice", () => {
	it("picks up a title edited in the README without a reload", async () => {
		const state = buildState();
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Original Title",
		});
		if (!created.ok) throw new Error(created.guidance);
		expect(state.questTitle).toBe("Original Title");

		// Edit the README H1 directly on disk.
		const readme = join(state.questDir as string, "README.md");
		const text = readFileSync(readme, "utf8").replace(
			"Original Title",
			"Renamed Title",
		);
		writeFileSync(readme, text);

		refreshLoadedSlice(state);
		expect(state.questTitle).toBe("Renamed Title");
	});

	it("is a no-op when no quest is loaded", () => {
		const state = buildState();
		expect(() => refreshLoadedSlice(state)).not.toThrow();
		expect(state.questTitle).toBeNull();
	});
});
