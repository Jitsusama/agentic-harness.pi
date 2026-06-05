import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
	} as unknown as Parameters<typeof handle>[1];
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

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string; path: string };
}

function parentOf(id: string): string {
	const text = readFileSync(join(tmpRoot, "quests", id, "README.md"), "utf8");
	const line = text.split("\n").find((l) => l.startsWith("parent:"));
	return (line ?? "").replace("parent:", "").trim();
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-reparent-"));
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	envGuard.leave();
});

describe("reparent verb", () => {
	it("moves a quest under a new parent and reports the change", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe(parent.id);
		const details = result.details as {
			changes: { id: string; newParent: string | null }[];
		};
		expect(details.changes).toEqual([
			{ id: child.id, oldParent: null, newParent: parent.id },
		]);
	});

	it("previews without writing when dryRun is set", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
			dryRun: true,
		});
		expect(result.ok).toBe(true);
		// Nothing written: the child stays top-level.
		expect(parentOf(child.id)).toBe("null");
		const details = result.details as { dryRun: boolean };
		expect(details.dryRun).toBe(true);
	});

	it("reparents many quests in one call", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const a = await createQuest(state, "A");
		const b = await createQuest(state, "B");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: `${a.id},${b.id}`,
			parent: parent.id,
		});
		expect(result.ok).toBe(true);
		expect(parentOf(a.id)).toBe(parent.id);
		expect(parentOf(b.id)).toBe(parent.id);
	});

	it("refuses the whole batch and writes nothing when any target errors", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: `${child.id},QEST-20260604-GONE99`,
			parent: parent.id,
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/GONE99/);
		// The valid target was not moved: the batch is atomic.
		expect(parentOf(child.id)).toBe("null");
	});

	it("undo reverses the last reparent, restoring the prior parent", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(parentOf(child.id)).toBe(parent.id);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe("null");
	});

	it("does not journal a dry run, so undo finds nothing", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
			dryRun: true,
		});
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/nothing to undo/i);
	});

	it("refuses undo when nothing has been done", async () => {
		const state = buildState();
		await createQuest(state, "Solo");
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "undo",
		});
		expect(result.ok).toBe(false);
		expect(result.guidance).toMatch(/nothing to undo/i);
	});

	it("moves a quest back to top level with parent=null", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const child = await createQuest(state, "Child");
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: parent.id,
		});
		expect(parentOf(child.id)).toBe(parent.id);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "reparent",
			id: child.id,
			parent: "null",
		});
		expect(result.ok).toBe(true);
		expect(parentOf(child.id)).toBe("null");
	});
});
