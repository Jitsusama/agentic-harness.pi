import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persist, restore } from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

interface AppendedEntry {
	customType: string;
	data: unknown;
}

let tmpRoot: string;
let entries: AppendedEntry[];

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
	} as unknown as Parameters<typeof handle>[1];
}

function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () =>
				entries.map((e) => ({
					type: "custom" as const,
					customType: e.customType,
					data: e.data,
				})),
		},
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ homeDir: tmpRoot, dataDir: tmpRoot });
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-persist-"));
	entries = [];
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const r = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		kind: "quest",
		title,
	});
	expect(r.ok).toBe(true);
	return {
		id: state.questId as string,
		dir: state.questDir as string,
	};
}

describe("persist + restore", () => {
	it("persists the loaded quest and restores it on a fresh state", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, fakePi());

		// Fresh state, same session history. restore picks up
		// the quest that was loaded before the reload.
		const next = buildState();
		const restored = restore(next, fakePi(), fakeCtx(tmpRoot));
		expect(restored).toBe(true);
		expect(next.questId).toBe(a.id);
		expect(next.questTitle).toBe("Alpha");
	});

	it("returns false when nothing is persisted", () => {
		const state = buildState();
		const restored = restore(state, fakePi(), fakeCtx(tmpRoot));
		expect(restored).toBe(false);
		expect(state.questId).toBeNull();
	});

	it("restores the focused document alongside the quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "think",
			kind: "plan",
			note: "investigate",
		});
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "draft",
			title: "Doc One",
		});
		expect(state.documentPath).not.toBeNull();
		persist(state, fakePi());

		const next = buildState();
		const restored = restore(next, fakePi(), fakeCtx(tmpRoot));
		expect(restored).toBe(true);
		expect(next.questId).toBe(a.id);
		expect(next.documentPath).toBe(state.documentPath);
		expect(next.documentId).toBe(state.documentId);
	});

	it("only the most recent entry hydrates state", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Beta");

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, fakePi());
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		persist(state, fakePi());

		const next = buildState();
		const restored = restore(next, fakePi(), fakeCtx(tmpRoot));
		expect(restored).toBe(true);
		expect(next.questId).toBe(b.id);
	});

	it("refuses to restore a quest that no longer exists on disk", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, fakePi());

		// Wipe the on-disk quest while keeping the session
		// entry pointing at it. Restore should report false
		// instead of half-loading or throwing.
		rmSync(a.dir, { recursive: true, force: true });
		const next = buildState();
		const restored = restore(next, fakePi(), fakeCtx(tmpRoot));
		expect(restored).toBe(false);
		expect(next.questId).toBeNull();
	});
});
