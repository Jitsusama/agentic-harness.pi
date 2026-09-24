import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { defaultWorkspaceRoot } from "../../../extensions/quest-workflow/workspace";
import { ensureQuestScratchDir } from "../../../lib/internal/quest/scratch";

let root: string;
let savedCache: string | undefined;

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

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bulk-conclude-"));
	savedCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterEach(() => {
	if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedCache;
	rmSync(root, { recursive: true, force: true });
});

async function twoQuests() {
	const state = createQuestState({ questsRoot: join(root, "quests") });
	const ids: string[] = [];
	for (const title of ["First Sweep", "Second Sweep"]) {
		const created = await handle(state, fakePi(), fakeCtx(root), {
			action: "create",
			title,
		});
		if (!created.ok) throw new Error(created.guidance);
		ids.push(state.questId ?? "");
	}
	const workspace = (id: string, rel: string) =>
		join(defaultWorkspaceRoot(), id, rel);
	for (const id of ids) {
		for (const rel of ["tmp/run.log", "lab/results.csv"]) {
			mkdirSync(join(workspace(id, rel), ".."), { recursive: true });
			writeFileSync(workspace(id, rel), "x\n");
		}
	}
	const sweep = (action: "conclude" | "retire") =>
		handle(state, fakePi(), fakeCtx(root), {
			action,
			id: ids.join(","),
			reason: "swept",
		});
	return { state, ids, workspace, sweep };
}

describe("sweeping quests by id", () => {
	for (const action of ["conclude", "retire"] as const) {
		it(`clears each quest's workspace tmp/ on ${action}, keeping the rest`, async () => {
			const { state, ids, workspace, sweep } = await twoQuests();
			const result = await sweep(action);
			expect(result.ok).toBe(true);
			for (const id of ids) {
				expect(existsSync(workspace(id, "tmp"))).toBe(false);
				expect(existsSync(workspace(id, "lab/results.csv"))).toBe(true);
				const readme = readFileSync(
					join(state.questsRoot, id, "README.md"),
					"utf8",
				);
				expect(readme).toContain("Cleared the workspace's tmp/ folder.");
			}
		});
	}

	it("reaps the scratch each quest recorded before workspaces", async () => {
		const { state, ids, sweep } = await twoQuests();
		const scratch = ids.map((id) =>
			ensureQuestScratchDir(join(state.questsRoot, id), id, null),
		);
		const result = await sweep("conclude");
		expect(result.ok).toBe(true);
		for (const [i, id] of ids.entries()) {
			expect(existsSync(scratch[i] ?? "")).toBe(false);
			const readme = readFileSync(
				join(state.questsRoot, id, "README.md"),
				"utf8",
			);
			expect(readme).not.toContain("scratchDir");
		}
	});
});
