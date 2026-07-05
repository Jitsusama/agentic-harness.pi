import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { addTreeToQuest } from "../../../lib/internal/quest/trees";
import type { TreeProvider } from "../../../lib/tree/index";
import {
	clearTreeProviders,
	registerTreeProvider,
} from "../../../lib/tree/index";
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
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-prune-binding-"));
	clearTreeProviders();
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
});

describe("tree-prune provider binding", () => {
	it("dispatches to the tree's stored providerId, not resolution order", async () => {
		const pruned: string[] = [];
		const bound: TreeProvider = {
			id: "bound",
			priority: 100,
			// Never wins resolution: only the stored providerId should
			// reach it.
			appliesTo: () => false,
			create: async () => ({ path: "", providerId: "bound" }),
			prune: async ({ path }) => {
				pruned.push(path);
			},
		};
		const wrong: TreeProvider = {
			id: "wrong",
			priority: 1,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "wrong" }),
			prune: async () => {
				throw new Error("resolution picked the wrong provider");
			},
		};
		registerTreeProvider(bound);
		registerTreeProvider(wrong);

		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Bound Tree",
		});
		if (!created.ok) throw new Error(created.guidance);
		const treePath = join(tmpRoot, "some-tree");
		addTreeToQuest(state.questDir ?? "", {
			path: treePath,
			providerId: "bound",
			repoRoot: treePath,
			origin: "scaffolded",
		});

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			target: treePath,
		});
		expect(result.ok).toBe(true);
		expect(pruned).toEqual([treePath]);
	});
});
