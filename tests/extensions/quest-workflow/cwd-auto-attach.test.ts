import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreFromCwd } from "../../../extensions/quest-workflow/lifecycle";
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
	const dir = mkdtempSync(join(tmpdir(), "cwd-attach-repo-"));
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "README.md"), "scratch\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-qm", "initial");
	return dir;
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), "cwd-attach-state-"));
	repoRoot = await makeRepo();
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
});

describe("restoreFromCwd (session_start handler)", () => {
	it("attaches the quest when the session's cwd is inside a registered tree", async () => {
		const state = buildState();
		const c = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature CWD",
		});
		const questId = (c.ok ? (c.details as { id?: string })?.id : undefined) as
			| string
			| undefined;
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-cwd",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const fresh = buildState();
		restoreFromCwd(fresh, fakePi(), fakeCtx(treePath));
		expect(fresh.questId).toBe(questId);
	});

	it("attaches when the session's cwd is a subdirectory of the tree", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature Sub",
		});
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-sub",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const deep = join(treePath, "src", "deep");
		mkdirSync(deep, { recursive: true });
		const fresh = buildState();
		restoreFromCwd(fresh, fakePi(), fakeCtx(deep));
		expect(fresh.questId).toBeTruthy();
	});

	it("does not attach when the cwd is outside every tree", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature None",
		});
		const fresh = buildState();
		const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
		try {
			restoreFromCwd(fresh, fakePi(), fakeCtx(elsewhere));
			expect(fresh.questId).toBeNull();
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("matches a tree path reached through a symlink (macOS /var vs /private/var)", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature Symlinked",
		});
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-symlinked",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const realTreePath = realpathSync(treePath);
		const linkRoot = mkdtempSync(join(tmpdir(), "sym-cwd-"));
		const linkPath = join(linkRoot, "linked");
		try {
			symlinkSync(realTreePath, linkPath);
		} catch {
			rmSync(linkRoot, { recursive: true, force: true });
			return;
		}
		try {
			const fresh = buildState();
			restoreFromCwd(fresh, fakePi(), fakeCtx(linkPath));
			expect(fresh.questId).toBeTruthy();
		} finally {
			rmSync(linkRoot, { recursive: true, force: true });
		}
	});
});

describe("quest load with no id falls back to the cwd-resolved quest", () => {
	it("resolves to the same quest restoreFromCwd would pick", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Parity",
		});
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "parity",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const fresh1 = buildState();
		restoreFromCwd(fresh1, fakePi(), fakeCtx(treePath));
		const fresh2 = buildState();
		const loaded = await handle(fresh2, fakePi(), fakeCtx(treePath), {
			action: "load",
		});
		expect(loaded.ok).toBe(true);
		expect(fresh1.questId).toBe(fresh2.questId);
	});
});
