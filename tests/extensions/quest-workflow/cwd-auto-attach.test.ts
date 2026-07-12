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
	const dir = mkdtempSync(join(tmpdir(), "cwd-attach-repo-"));
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
	tmpRoot = mkdtempSync(join(tmpdir(), "cwd-attach-state-"));
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
		if (!added.ok) throw new Error(added.guidance);
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
		if (!added.ok) throw new Error(added.guidance);
		const treePath = (added.details as { tree: { path: string } }).tree.path;
		const deep = join(treePath, "src", "deep");
		mkdirSync(deep, { recursive: true });
		const fresh = buildState();
		restoreFromCwd(fresh, fakePi(), fakeCtx(deep));
		expect(fresh.questId).toBeTruthy();
	});

	it("prefers a live quest over a sealed one sharing the same scaffolded tree", () => {
		// Two quests can scaffold a tree at the same path. When both
		// cover the cwd at equal depth, the live quest must win,
		// matching the explicit load verb's resolver.
		const shared = join(repoRoot, "shared-tree");
		mkdirSync(shared, { recursive: true });
		const writeQuest = (id: string, status: string) => {
			const dir = join(tmpRoot, "quests", id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "README.md"),
				`---\nid: ${id}\nkind: quest\nparent: null\nstatus: ${status}\npriority: someday\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01\ntrees:\n  - path: ${shared}\n    providerId: git-worktree\n    origin: scaffolded\n---\n\n# ${id}\n\nBody.\n`,
			);
		};
		writeQuest("QEST-20260101-SEALD0", "concluded");
		writeQuest("QEST-20260101-LIVE00", "active");

		const fresh = buildState();
		restoreFromCwd(fresh, fakePi(), fakeCtx(shared));
		expect(fresh.questId).toBe("QEST-20260101-LIVE00");
	});

	it("does not auto-load from an adopted shared checkout", () => {
		// The bug that motivated the narrowing: a checkout adopted by
		// several quests must not magnetize a fresh session.
		const shared = join(repoRoot, "adopted-checkout");
		mkdirSync(shared, { recursive: true });
		const dir = join(tmpRoot, "quests", "QEST-20260101-ADOPT0");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "README.md"),
			`---\nid: QEST-20260101-ADOPT0\nkind: quest\nparent: null\nstatus: active\npriority: someday\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01\ntrees:\n  - path: ${shared}\n    providerId: git-worktree\n    origin: adopted\n---\n\n# Adopted\n\nBody.\n`,
		);
		const fresh = buildState();
		restoreFromCwd(fresh, fakePi(), fakeCtx(shared));
		expect(fresh.questId).toBeNull();
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
		if (!added.ok) throw new Error(added.guidance);
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
		if (!added.ok) throw new Error(added.guidance);
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
