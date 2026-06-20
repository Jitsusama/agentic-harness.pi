import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceQuest } from "../../../extensions/quest-workflow/enforce";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { addTreeToQuest } from "../../../lib/internal/quest/trees";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/tree/index";
import { createEnvGuard } from "./_helpers";

const execFileAsync = promisify(execFile);

// The state dir is not a git repo, so paths under it read as
// loose files; tempRoots is forced to [] so the system temp
// dir does not auto-classify those fixtures as scratch.
let tmpRoot: string;
let repoRoot: string;
const noScratch = { tempRoots: [] as string[] };

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

describe("build transition", () => {
	it("crosses into build with no tree, never refusing", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "build",
		});
		expect(result.ok).toBe(true);
	});

	it("still crosses into build after a tree is added", async () => {
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

function trackRepo(state: ReturnType<typeof buildState>) {
	const added = addTreeToQuest(state.questDir ?? "", {
		path: repoRoot,
		providerId: "git-worktree",
		origin: "adopted",
	});
	if (!added.ok) throw new Error(added.reason);
}

describe("build home gate", () => {
	it("allows a write inside a tracked git working tree", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		trackRepo(state);
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(repoRoot, "src/foo.ts") },
			repoRoot,
			noScratch,
		);
		expect(verdict).toBeUndefined();
	});

	it("blocks a write in an untracked git tree with tree-adopt guidance", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(repoRoot, "src/foo.ts") },
			repoRoot,
			noScratch,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/tree-adopt/);
		expect(verdict?.reason).toContain(repoRoot);
	});

	it("allows writes to the quest's own document directories", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const docPath = join(state.questDir ?? "", "plans", "PLAN-something.md");
		const verdict = enforceQuest(
			state,
			"write",
			{ path: docPath },
			state.questDir ?? "",
			noScratch,
		);
		expect(verdict).toBeUndefined();
	});

	it("allows writes to any path under the loaded quest dir, not just named subdirs", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		for (const rel of ["notes.md", "runs/2026-06-03.log"]) {
			const p = join(state.questDir ?? "", rel);
			const verdict = enforceQuest(
				state,
				"write",
				{ path: p },
				state.questDir ?? "",
				noScratch,
			);
			expect(verdict).toBeUndefined();
		}
	});

	it("blocks a homeless write outside every git working tree", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(tmpRoot, "outside.ts") },
			tmpRoot,
			noScratch,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/tree-add/);
	});

	it("blocks a homeless bash redirect, like the write tool", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"bash",
			{ command: `cat > ${join(tmpRoot, "outside.ts")}` },
			tmpRoot,
			noScratch,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/tree-add/);
	});

	it("allows a bash redirect inside a tracked git working tree", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		trackRepo(state);
		const verdict = enforceQuest(
			state,
			"bash",
			{ command: `cat > ${join(repoRoot, "src/foo.ts")}` },
			repoRoot,
			noScratch,
		);
		expect(verdict).toBeUndefined();
	});
});

// These run with the production default temp roots (no tempRoots
// override), the wiring the prior fix never exercised: a literal
// /tmp write and a /dev/null redirect under the real defaults.
describe("scratch funnel", () => {
	// Track every managed scratch dir the gate creates and reap them in
	// afterEach, so a failed assertion never leaks a dir under tmpdir.
	const scratchDirs: string[] = [];
	const trackScratch = (state: { scratchDir: string | null }) => {
		if (state.scratchDir) scratchDirs.push(state.scratchDir);
	};
	afterEach(() => {
		for (const dir of scratchDirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("allows a /dev/null redirect in build", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"bash",
			{ command: "echo hi > /dev/null 2>&1" },
			repoRoot,
		);
		expect(verdict).toBeUndefined();
	});

	it("blocks a literal /tmp write with a scratch remedy, not tree-add", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"write",
			{ path: "/tmp/repro.log" },
			repoRoot,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/scratch/i);
		expect(verdict?.reason).not.toMatch(/tree-add/);
		expect(state.scratchDir).toBeTruthy();
		trackScratch(state);
	});

	it("blocks a /tmp bash redirect and names the managed scratch dir", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		const verdict = enforceQuest(
			state,
			"bash",
			{ command: "go test ./... > /tmp/test.log 2>&1" },
			repoRoot,
		);
		expect(verdict?.block).toBe(true);
		expect(state.scratchDir).toBeTruthy();
		expect(verdict?.reason).toContain(state.scratchDir ?? "<none>");
		trackScratch(state);
	});

	it("allows a write into the managed scratch dir once created", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		enforceQuest(state, "write", { path: "/tmp/seed.log" }, repoRoot);
		const scratch = state.scratchDir ?? "";
		const verdict = enforceQuest(
			state,
			"write",
			{ path: join(scratch, "run.log") },
			repoRoot,
		);
		expect(verdict).toBeUndefined();
		trackScratch(state);
	});

	it("funnels system temp in draft too", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		expect(state.documentStage).toBe("draft");
		const verdict = enforceQuest(
			state,
			"write",
			{ path: "/tmp/draft-repro.log" },
			repoRoot,
		);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toMatch(/scratch/i);
		trackScratch(state);
	});

	it("reaps the managed scratch dir on conclude", async () => {
		const state = buildState();
		await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		enforceQuest(state, "write", { path: "/tmp/seed.log" }, repoRoot);
		const dir = state.scratchDir ?? "";
		expect(existsSync(dir)).toBe(true);
		const concluded = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "conclude",
			scope: "quest",
		});
		expect(concluded.ok).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(state.scratchDir).toBeNull();
		scratchDirs.push(dir);
	});

	it("hydrates the recorded scratch dir into a fresh state on load", async () => {
		const state = buildState();
		const quest = await createQuestWithPlan(state);
		await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
		enforceQuest(state, "write", { path: "/tmp/seed.log" }, repoRoot);
		const dir = state.scratchDir ?? "";
		expect(dir).toBeTruthy();

		const fresh = buildState();
		const loaded = await handle(fresh, fakePi(), fakeCtx(repoRoot), {
			action: "load",
			id: quest.id,
		});
		expect(loaded.ok).toBe(true);
		expect(fresh.scratchDir).toBe(dir);
		scratchDirs.push(dir);
	});
});
