import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceQuest } from "../../../extensions/quest-workflow/enforce";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/tree/index";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
let repoRoot: string;

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
	return createQuestState({ homeDir: tmpRoot, dataDir: tmpRoot });
}

async function git(cwd: string, ...args: string[]) {
	await execFileAsync("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "tree-gate-repo-"));
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "README.md"), "scratch\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-qm", "initial");
	return dir;
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-gate-state-"));
	repoRoot = await makeRepo();
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
});

async function createQuestWithPlan(state: ReturnType<typeof buildState>) {
	const q = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title: "Code Stream",
	});
	if (!q.ok) throw new Error(q.guidance);
	await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "think",
		kind: "plan",
		note: "Exploring",
	});
	const drafted = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "draft",
		title: "First plan",
	});
	if (!drafted.ok) throw new Error(drafted.guidance);
	return q.details as { id: string; path: string };
}

describe("build-stage tree gate", () => {
	it("refuses build for a primary plan with no tree", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.guidance).toMatch(/tree-add/);
	});

	it("allows build when the agent passes skipTree:true", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
			skipTree: true,
		});
		expect(result.ok).toBe(true);
	});

	it("allows build after a tree is added", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-build",
			cwd: repoRoot,
		});
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
		});
		expect(result.ok).toBe(true);
	});
});

describe("reactive no-tree guardian", () => {
	it("blocks writes outside the quest dir when no tree exists", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
			skipTree: true,
		});
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(repoRoot, "src/foo.ts") },
			repoRoot,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/tree-add/);
	});

	it("allows writes to the quest's own document directories", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
			skipTree: true,
		});
		const docPath = join(state.questDir ?? "", "plans", "PLAN-something.md");
		const verdict = enforceQuest(
			state,
			"write",
			{ path: docPath },
			state.questDir ?? "",
		);
		expect(verdict).toBeUndefined();
	});

	it("allows writes when a tree exists", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-guard",
			cwd: repoRoot,
		});
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
		});
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(repoRoot, "src/foo.ts") },
			repoRoot,
		);
		expect(verdict).toBeUndefined();
	});
});
