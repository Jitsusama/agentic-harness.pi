import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persist, restore } from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/quest/index";
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
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
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

	it("skips appending when the snapshot equals the most recent entry", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});

		const questEntriesBefore = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;

		// One persist with ctx commits the first snapshot.
		// Four back-to-back persists with no state change
		// dedup against it.
		persist(state, fakePi(), fakeCtx(tmpRoot));
		const afterFirst = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(afterFirst - questEntriesBefore).toBe(1);

		for (let i = 0; i < 4; i++) persist(state, fakePi(), fakeCtx(tmpRoot));
		const afterRepeats = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(afterRepeats).toBe(afterFirst);
	});

	it("appends a new entry after state changes", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, fakePi(), fakeCtx(tmpRoot));
		const before = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;

		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		persist(state, fakePi(), fakeCtx(tmpRoot));
		const after = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(after - before).toBe(1);
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

describe("persisted cwd", () => {
	it("records the session cwd in the snapshot", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx("/work/here"), {
			action: "load",
			id: a.id,
		});
		persist(state, fakePi(), fakeCtx("/work/here"));
		const last = entries
			.filter((e) => e.customType === "quest-workflow")
			.at(-1);
		expect((last?.data as { cwd?: string }).cwd).toBe("/work/here");
	});
});

describe("auto-attach on load", () => {
	function sessionsOf(dir: string) {
		const text = readFileSync(join(dir, "README.md"), "utf8");
		const parsed = parseQuestFrontMatter(text);
		return parsed?.frontMatter.sessions ?? [];
	}

	it("attaches the current session to the loaded quest's frontmatter", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const sessions = sessionsOf(a.dir);
		const mine = sessions.find((s) => s.id === "sess-load");
		expect(mine).toBeDefined();
		expect(mine?.status).toBe("active");
		expect(mine?.cwd).toBe("/work/dir");
	});

	it("does not duplicate the session when the same quest is reloaded", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		await handle(state, fakePi(), fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const mine = sessionsOf(a.dir).filter((s) => s.id === "sess-load");
		expect(mine).toHaveLength(1);
	});

	it("preserves the original started timestamp across reloads", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const firstStarted = sessionsOf(a.dir).find(
			(s) => s.id === "sess-load",
		)?.started;
		expect(firstStarted).toBeDefined();

		// A later load of the same session must not re-stamp started to
		// the latest attach time.
		await handle(state, fakePi(), fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const secondStarted = sessionsOf(a.dir).find(
			(s) => s.id === "sess-load",
		)?.started;
		expect(secondStarted).toBe(firstStarted);
	});
});
