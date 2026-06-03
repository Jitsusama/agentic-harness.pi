import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("quest load auto-attach by cwd", () => {
	it("loads the quest when cwd is inside a registered tree", async () => {
		const state = buildState();
		const c = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature CWD",
		});
		const questId = (c.ok ? c.details : undefined) as
			| { id: string }
			| undefined;
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-cwd",
			cwd: repoRoot,
		});
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		// Fresh state simulates a new pi session.
		const fresh = buildState();
		const result = await handle(fresh, fakePi(), fakeCtx(treePath), {
			action: "load",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.details?.id).toBe(questId?.id);
		}
	});

	it("loads the quest when cwd is a subdirectory of the tree", async () => {
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
		const fresh = buildState();
		const result = await handle(fresh, fakePi(), fakeCtx(deep), {
			action: "load",
		});
		expect(result.ok).toBe(true);
	});

	it("refuses load when cwd is outside any tree", async () => {
		const state = buildState();
		await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Feature None",
		});
		const fresh = buildState();
		const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
		try {
			const result = await handle(fresh, fakePi(), fakeCtx(elsewhere), {
				action: "load",
			});
			expect(result.ok).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});
