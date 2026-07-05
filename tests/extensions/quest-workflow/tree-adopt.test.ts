import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
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
import { addTreeToQuest } from "../../../lib/internal/quest/trees";
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
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-adopt-state-"));
	repoRoot = mkdtempSync(join(tmpdir(), "tree-adopt-repo-"));
	const git = (...a: string[]) => execFileAsync("git", a, { cwd: repoRoot });
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "t@t");
	await git("config", "user.name", "t");
	writeFileSync(join(repoRoot, "README.md"), "x\n");
	await git("add", "README.md");
	await git("commit", "-qm", "seed");
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
});

describe("tree-adopt", () => {
	it("registers the enclosing git tree as adopted", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Adopt the Root",
		});
		if (!created.ok) throw new Error(created.guidance);
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-adopt",
			cwd: repoRoot,
		});
		expect(result.ok).toBe(true);
		const fm = parseQuestFrontMatter(
			readFileSync(join(state.questDir ?? "", "README.md"), "utf8"),
		)?.frontMatter;
		expect(fm?.trees?.[0]?.origin).toBe("adopted");
	});

	it("refuses a manual prune of an adopted tree without force", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Adopted Prune Guard",
		});
		if (!created.ok) throw new Error(created.guidance);
		// A real, clean secondary worktree: without the origin guard a
		// non-force prune would happily delete it.
		const wt = join(tmpRoot, "adopted-guard-wt");
		await execFileAsync("git", ["worktree", "add", "-b", "guard", wt], {
			cwd: repoRoot,
		});
		const adopted = await handle(state, fakePi(), fakeCtx(wt), {
			action: "tree-adopt",
			cwd: wt,
		});
		expect(adopted.ok).toBe(true);

		const blocked = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-prune",
			target: realpathSync(wt),
		});
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error("unreachable");
		expect(blocked.guidance).toMatch(/adopted|force/i);
		// The adopted checkout is untouched.
		expect(existsSync(wt)).toBe(true);
	});

	it("keeps an adopted tree when the quest is retired", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Keep My Tree",
		});
		if (!created.ok) throw new Error(created.guidance);
		// A real, prunable worktree that retire would remove if it were
		// scaffolded; adopting it must spare it.
		const wt = join(tmpRoot, "adopted-wt");
		await execFileAsync("git", ["worktree", "add", "-b", "adopted", wt], {
			cwd: repoRoot,
		});
		const adopted = await handle(state, fakePi(), fakeCtx(wt), {
			action: "tree-adopt",
			cwd: wt,
		});
		expect(adopted.ok).toBe(true);
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "done",
		});
		expect(retired.ok).toBe(true);
		if (retired.ok) {
			const details = retired.details as { prunedTrees?: string[] };
			// prunedTrees records canonicalized paths, so compare against
			// the canonical form of wt rather than its raw mkdtemp path,
			// which on macOS differs (/var versus /private/var) and would
			// make the assertion pass vacuously.
			expect(details.prunedTrees ?? []).not.toContain(realpathSync(wt));
		}
		expect(existsSync(wt)).toBe(true);
	});

	it("keeps a legacy tree with no origin marker when retired", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Legacy Tree",
		});
		if (!created.ok) throw new Error(created.guidance);
		const wt = join(tmpRoot, "legacy-wt");
		await execFileAsync("git", ["worktree", "add", "-b", "legacy", wt], {
			cwd: repoRoot,
		});
		// Register it the way a pre-marker tree would be recorded: with
		// no origin field at all.
		const added = addTreeToQuest(state.questDir ?? "", {
			path: realpathSync(wt),
			providerId: "git-worktree",
		});
		expect(added.ok).toBe(true);
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			scope: "quest",
			reason: "done",
		});
		expect(retired.ok).toBe(true);
		if (retired.ok) {
			const details = retired.details as { prunedTrees?: string[] };
			expect(details.prunedTrees ?? []).not.toContain(realpathSync(wt));
		}
		expect(existsSync(wt)).toBe(true);
	});
});
