import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter";
import { clearUrlFetchers } from "../../../lib/quest/index";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/tree/index";
import { createEnvGuard } from "./_helpers";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
let repoRoot: string;

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
	return createQuestState({ homeDir: tmpRoot, dataDir: tmpRoot });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.toString();
}

async function makeRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "tree-verbs-repo-"));
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
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-verbs-state-"));
	repoRoot = await makeRepo();
	clearRefTypes();
	registerBuiltinRefTypes();
	clearUrlFetchers();
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearRefTypes();
	clearUrlFetchers();
	clearTreeProviders();
	envGuard.leave();
});

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	const details = result.details as { id: string; path: string };
	return details;
}

describe("tree-add", () => {
	it("creates a worktree, records it on the quest and adds aliases", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature X");
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-x",
			cwd: repoRoot,
		});
		expect(result.ok).toBe(true);
		const tree = (result.details as { tree: { path: string; branch: string } })
			.tree;
		expect(tree.path).toBe(join(repoRoot, ".worktrees", "feature-x"));
		expect(tree.branch).toBe("feature-x");
		expect(existsSync(tree.path)).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.trees?.[0].path).toBe(tree.path);
		expect(
			fm?.aliases.some(
				(a) => a.type === "git-worktree" && a.value === tree.path,
			),
		).toBe(true);
		expect(
			fm?.aliases.some(
				(a) => a.type === "git-branch" && a.value === "feature-x",
			),
		).toBe(true);
	});

	it("refuses when no quest is loaded", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-y",
			cwd: repoRoot,
		});
		expect(result.ok).toBe(false);
	});
});

describe("tree-list", () => {
	it("returns the trees on the loaded quest", async () => {
		const state = buildState();
		await createQuest(state, "Feature L");
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-l",
			cwd: repoRoot,
		});
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-list",
		});
		expect(result.ok).toBe(true);
		const trees = (result.details as { trees: { path: string }[] }).trees;
		expect(trees).toHaveLength(1);
		expect(trees[0].path).toBe(join(repoRoot, ".worktrees", "feature-l"));
	});
});

describe("tree-prune", () => {
	it("prunes a clean tree and clears the frontmatter entry", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature P");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-p",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: treePath,
		});
		expect(pruned.ok).toBe(true);
		expect(existsSync(treePath)).toBe(false);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.trees ?? []).toHaveLength(0);
	});

	it("records pendingPrune and refuses on dirty tree", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature D");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-d",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		writeFileSync(join(treePath, "scratch.txt"), "dirty\n");
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: treePath,
		});
		expect(pruned.ok).toBe(false);
		expect(existsSync(treePath)).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.pendingPrune).toHaveLength(1);
		expect(fm?.pendingPrune?.[0].path).toBe(treePath);
		expect(fm?.pendingPrune?.[0].reason).toMatch(/uncommitted/);
	});

	it("force-prunes a dirty tree and clears the pendingPrune for that path", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature F");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-f",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		writeFileSync(join(treePath, "scratch.txt"), "dirty\n");
		// Non-force prune first: the refusal records a
		// pendingPrune entry against this tree's path.
		const blocked = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: treePath,
		});
		expect(blocked.ok).toBe(false);
		const blockedFm = parseQuestFrontMatter(
			readFileSync(q.path, "utf8"),
		)?.frontMatter;
		expect(blockedFm?.pendingPrune?.[0].path).toBe(treePath);

		// Force-prune second: succeeds and clears the entry.
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: treePath,
			force: true,
		});
		expect(pruned.ok).toBe(true);
		expect(existsSync(treePath)).toBe(false);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.pendingPrune).toBeUndefined();
		expect(fm?.trees ?? []).toHaveLength(0);
	});
});

describe("tree-prune attached-session refusal", () => {
	it("refuses when a session is attached inside the tree", async () => {
		const state = buildState();
		await createQuest(state, "Feature S");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-s",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const attachResult = await handle(
			state,
			fakePi(),
			fakeCtx(treePath, "sess-inside"),
			{ action: "session-attach", cwd: treePath },
		);
		expect(attachResult.ok).toBe(true);
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: treePath,
		});
		expect(pruned.ok).toBe(false);
		if (!pruned.ok) {
			expect(pruned.guidance).toMatch(/attached/);
		}
	});
});

describe("retire auto-prunes trees", () => {
	it("prunes clean trees on retire and journals each prune", async () => {
		const state = buildState();
		await createQuest(state, "Retire Clean");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-retire",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "done with it",
		});
		expect(retired.ok).toBe(true);
		if (retired.ok) {
			const details = retired.details as {
				prunedTrees: string[];
				blockedTrees: { path: string }[];
			};
			expect(details.prunedTrees).toContain(treePath);
			expect(details.blockedTrees).toHaveLength(0);
		}
		expect(existsSync(treePath)).toBe(false);
	});

	it("surfaces blocked trees as manual resolution on retire", async () => {
		const state = buildState();
		await createQuest(state, "Retire Dirty");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-dirty",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		writeFileSync(join(treePath, "dirt"), "x");
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "wrap up",
		});
		expect(retired.ok).toBe(true);
		if (retired.ok) {
			const details = retired.details as {
				prunedTrees: string[];
				blockedTrees: { path: string }[];
			};
			expect(details.prunedTrees).toHaveLength(0);
			expect(details.blockedTrees.map((b) => b.path)).toContain(treePath);
			expect(retired.message).toMatch(/need manual resolution/);
		}
		expect(existsSync(treePath)).toBe(true);
	});

	it("keeps every blocker on retire when multiple trees fail", async () => {
		const state = buildState();
		const q = await createQuest(state, "Retire Many Dirty");
		const t1 = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-multi-a",
			cwd: repoRoot,
		});
		const t2 = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-multi-b",
			cwd: repoRoot,
		});
		const path1 = (t1.details as { tree: { path: string } }).tree.path;
		const path2 = (t2.details as { tree: { path: string } }).tree.path;
		writeFileSync(join(path1, "dirt"), "x");
		writeFileSync(join(path2, "dirt"), "x");
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "both still pending",
		});
		expect(retired.ok).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		const pendingPaths = (fm?.pendingPrune ?? []).map((e) => e.path);
		expect(pendingPaths).toContain(path1);
		expect(pendingPaths).toContain(path2);
	});

	it("refuses to auto-prune a tree with an attached session", async () => {
		const state = buildState();
		const q = await createQuest(state, "Retire Attached");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-attached",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		await handle(state, fakePi(), fakeCtx(treePath, "sess-live"), {
			action: "session-attach",
			cwd: treePath,
		});
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "see you later",
		});
		expect(retired.ok).toBe(true);
		expect(existsSync(treePath)).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		const pending = fm?.pendingPrune ?? [];
		expect(pending.find((e) => e.path === treePath)?.reason).toMatch(
			/attached session/,
		);
	});
});

describe("tree-expand", () => {
	it("refuses on the built-in git-worktree provider", async () => {
		const state = buildState();
		await createQuest(state, "Feature E");
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-e",
			cwd: repoRoot,
		});
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-expand",
			ref: "system/foo",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.guidance).toMatch(/does not support expand/);
		}
	});
});
