import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryWorktrees } from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	type QuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

function scaffold(
	questId: string,
	title: string,
	trees: { path: string; branch?: string }[],
): void {
	const dir = join(tmpRoot, "quests", questId);
	mkdirSync(dir, { recursive: true });
	const fm: QuestFrontMatter = {
		id: questId,
		kind: "quest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-06-04",
		updated: "2026-06-04",
		aliases: [],
		sessions: [],
		trees: trees.map((t) => ({ ...t, providerId: "git-worktree" })),
	};
	writeFileSync(
		join(dir, "README.md"),
		`${serializeQuestFrontMatter(fm)}\n# ${title}\n`,
	);
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-inv-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("inventoryWorktrees", () => {
	it("lists every tree across quests attributed to its owner", () => {
		scaffold("QEST-20260604-AAA111", "Alpha", [
			{ path: "/work/a", branch: "feat-a" },
		]);
		scaffold("QEST-20260604-BBB222", "Bravo", [{ path: "/work/b" }]);
		const state = buildState();
		const inv = inventoryWorktrees(state);
		expect(inv).toHaveLength(2);
		const a = inv.find((t) => t.path === "/work/a");
		expect(a).toMatchObject({
			questId: "QEST-20260604-AAA111",
			questTitle: "Alpha",
			branch: "feat-a",
		});
	});

	it("tree-list with no loaded quest returns the global inventory", async () => {
		scaffold("QEST-20260604-CCC333", "Charlie", [{ path: "/work/c" }]);
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "tree-list",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		const details = result.details as {
			scope: string;
			trees: { path: string }[];
		};
		expect(details.scope).toBe("global");
		expect(details.trees.some((t) => t.path === "/work/c")).toBe(true);
	});
});
