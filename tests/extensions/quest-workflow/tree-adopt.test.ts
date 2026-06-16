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
			expect(details.prunedTrees ?? []).not.toContain(wt);
		}
		expect(existsSync(wt)).toBe(true);
	});
});
