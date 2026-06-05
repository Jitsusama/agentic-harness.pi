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
import { createEnvGuard } from "./_helpers";

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
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
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

const envGuard = createEnvGuard();

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-gate-state-"));
	repoRoot = await makeRepo();
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
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

	it("pins primaryPlanId on the first plan and lets second plans build freely", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		// First plan is the primary. Cross it into build via
		// the skipTree escape so the quest progresses.
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
			skipTree: true,
		});
		// Unfocus the first plan, then start a fresh loop for
		// a second plan. The fresh loop mints a new PLAN id
		// and goes through draft: that draft sees a primary is
		// already pinned, so it does not overwrite the pin.
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "unfocus",
		});
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "think",
			kind: "plan",
			note: "Secondary effort",
		});
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "draft",
			title: "Second plan",
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

	it("allows writes to any path under the loaded quest dir, not just named subdirs", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
			skipTree: true,
		});
		// notes.md at the quest root and a custom runs/ dir
		// should both be considered quest-internal, not
		// external code writes that need a tree.
		for (const rel of ["notes.md", "runs/2026-06-03.log"]) {
			const p = join(state.questDir ?? "", rel);
			const verdict = enforceQuest(
				state,
				"write",
				{ path: p },
				state.questDir ?? "",
			);
			expect(verdict).toBeUndefined();
		}
	});

	it("allows build-stage writes inside a recorded session's git working dir", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		// Record a session whose cwd is the git repo, then cross
		// into build without a registered tree. The gate should
		// stand down for writes inside that working directory.
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "session-attach",
			sessionId: "sess-code",
			cwd: repoRoot,
		});
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
