import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-add-cwd-state-"));
	repoRoot = mkdtempSync(join(tmpdir(), "tree-add-cwd-repo-"));
	const git = (...args: string[]) =>
		execFileAsync("git", args, { cwd: repoRoot });
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "t@t");
	await git("config", "user.name", "t");
	mkdirSync(join(repoRoot, "areas", "tools"), { recursive: true });
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
});

describe("tree-add from a repo subdirectory", () => {
	it("resolves the enclosing git root rather than failing on the subdir", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Code Stream",
		});
		if (!created.ok) throw new Error(created.guidance);
		const subdir = join(repoRoot, "areas", "tools");
		const result = await handle(state, fakePi(), fakeCtx(subdir), {
			action: "tree-add",
			name: "feature-x",
			cwd: subdir,
		});
		expect(result.ok).toBe(true);
	});
});
