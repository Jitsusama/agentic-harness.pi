/**
 * Escape reaches a tree provider through the quest tool.
 *
 * Cutting a tree is minutes on a big repo, and a sparse World cut is
 * longer, so a quest verb that kept the tool's signal to itself left
 * a person waiting on a cut nothing they pressed could end. The
 * provider contract carries the signal; these check the verbs hand it
 * over on every path that cuts or removes one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeProvider } from "@jitsusama/agentic-harness.core/tree";
import {
	clearTreeProviders,
	registerTreeProvider,
} from "@jitsusama/agentic-harness.core/tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { addTreeToQuest } from "../../../lib/internal/quest/trees";
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

/** A provider that records the signal each call was handed. */
function recording() {
	const handed: { call: string; signal?: AbortSignal }[] = [];
	const provider: TreeProvider = {
		id: "recording",
		priority: 100,
		appliesTo: () => true,
		create: async ({ name, repoRoot, signal }) => {
			handed.push({ call: "create", ...(signal ? { signal } : {}) });
			return { path: join(repoRoot, name), providerId: "recording" };
		},
		prune: async ({ signal }) => {
			handed.push({ call: "prune", ...(signal ? { signal } : {}) });
		},
	};
	registerTreeProvider(provider);
	return handed;
}

/** A loaded quest holding one tree the tool scaffolded. */
async function questWithTree() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title: "Stoppable Trees",
	});
	if (!created.ok) throw new Error(created.guidance);
	const treePath = join(tmpRoot, "some-tree");
	addTreeToQuest(state.questDir ?? "", {
		path: treePath,
		providerId: "recording",
		repoRoot: treePath,
		origin: "scaffolded",
	});
	return { state, treePath };
}

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-signal-"));
	clearTreeProviders();
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
});

describe("the quest tool's signal reaching the tree provider", () => {
	it("is handed to the cut a tree-add runs", async () => {
		const handed = recording();
		const { state } = await questWithTree();
		const { signal } = new AbortController();

		const result = await handle(
			state,
			fakePi(),
			fakeCtx(tmpRoot),
			{ action: "tree-add", cwd: tmpRoot, name: "cut-me" },
			signal,
		);

		expect(result.ok).toBe(true);
		expect(handed).toEqual([{ call: "create", signal }]);
	});

	it("is handed to the removal a tree-prune runs", async () => {
		const handed = recording();
		const { state, treePath } = await questWithTree();
		const { signal } = new AbortController();

		const result = await handle(
			state,
			fakePi(),
			fakeCtx(tmpRoot),
			{ action: "tree-prune", target: treePath },
			signal,
		);

		expect(result.ok).toBe(true);
		expect(handed).toEqual([{ call: "prune", signal }]);
	});

	it("is handed to the removals retiring a quest runs", async () => {
		const handed = recording();
		const { state } = await questWithTree();
		const { signal } = new AbortController();

		const result = await handle(
			state,
			fakePi(),
			fakeCtx(tmpRoot),
			{ action: "retire", reason: "no longer needed" },
			signal,
		);

		expect(result.ok).toBe(true);
		expect(handed).toEqual([{ call: "prune", signal }]);
	});

	it("leaves the quest unsealed when retiring it is stopped mid-prune", async () => {
		// Escape during the prune is the person taking the retire back,
		// so sealing the quest behind them anyway would be the one
		// outcome they pressed a key to prevent.
		const stop = new AbortController();
		registerTreeProvider({
			id: "recording",
			priority: 100,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "recording" }),
			prune: async () => {
				stop.abort();
				throw new Error("git worktree remove was stopped");
			},
		});
		const { state } = await questWithTree();

		const result = await handle(
			state,
			fakePi(),
			fakeCtx(tmpRoot),
			{ action: "retire", reason: "no longer needed" },
			stop.signal,
		);

		expect(result.ok).toBe(false);
		expect(state.questStatus).toBe("active");
	});
});
