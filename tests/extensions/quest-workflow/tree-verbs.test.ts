import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
	registerTreeProvider,
	type TreeProvider,
} from "../../../lib/core/tree/index.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { addTreeToQuest } from "../../../lib/internal/quest/trees.ts";
import { clearUrlFetchers } from "../../../lib/quest/index.ts";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import { createEnvGuard, succeeded } from "./_helpers.ts";

let tmpRoot: string;
let repoRoot: string;

function fakeCtx(cwd: string, sessionId = "sess-1") {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-verbs-state-"));
	repoRoot = await freshRepo("tree-verbs-repo");
	clearRefTypes();
	registerBuiltinRefTypes();
	clearUrlFetchers();
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	disposeRepo(repoRoot);
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
		expect(result).toMatchObject({ ok: true });
		const tree = (
			succeeded(result).details as {
				tree: { path: string; branch: string };
			}
		).tree;
		expect(tree.path).toBe(join(repoRoot, ".worktrees", "feature-x"));
		expect(tree.branch).toBe("feature-x");
		expect(existsSync(tree.path), `${tree.path} exists`).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.trees?.[0].path).toBe(tree.path);
		// The path lives in trees alone; only the branch is mirrored.
		expect(fm?.aliases).not.toContainEqual(
			expect.objectContaining({ type: "git-worktree" }),
		);
		expect(fm?.aliases).toContainEqual(
			expect.objectContaining({ type: "git-branch", value: "feature-x" }),
		);
	});

	it("refuses when no quest is loaded", async () => {
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-y",
			cwd: repoRoot,
		});
		expect(result).toMatchObject({ ok: false });
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
		expect(result).toMatchObject({ ok: true });
		const trees = (succeeded(result).details as { trees: { path: string }[] })
			.trees;
		expect(trees).toHaveLength(1);
		expect(trees[0].path).toBe(join(repoRoot, ".worktrees", "feature-l"));
	});
});

describe("tree-release", () => {
	it("prunes a clean tree and clears the frontmatter entry", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature P");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-p",
			cwd: repoRoot,
		});
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-release",
			target: treePath,
		});
		expect(pruned).toMatchObject({ ok: true });
		expect(existsSync(treePath), `${treePath} is removed`).toBe(false);
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
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		writeFileSync(join(treePath, "scratch.txt"), "dirty\n");
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-release",
			target: treePath,
		});
		expect(pruned).toMatchObject({ ok: false });
		expect(existsSync(treePath), `${treePath} is kept`).toBe(true);
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
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		writeFileSync(join(treePath, "scratch.txt"), "dirty\n");
		// Non-force prune first: the refusal records a
		// pendingPrune entry against this tree's path.
		const blocked = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-release",
			target: treePath,
		});
		expect(blocked).toMatchObject({ ok: false });
		const blockedFm = parseQuestFrontMatter(
			readFileSync(q.path, "utf8"),
		)?.frontMatter;
		expect(blockedFm?.pendingPrune?.[0].path).toBe(treePath);

		// Force-prune second: succeeds and clears the entry.
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-release",
			target: treePath,
			force: true,
		});
		expect(pruned).toMatchObject({ ok: true });
		expect(existsSync(treePath), `${treePath} is removed`).toBe(false);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.pendingPrune).toBeUndefined();
		expect(fm?.trees ?? []).toHaveLength(0);
	});

	it("drops the record of an adopted tree already gone, without force", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature G");
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-adopt",
			cwd: repoRoot,
			force: true,
		});
		rmSync(repoRoot, { recursive: true, force: true });

		const released = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-release",
			cwd: repoRoot,
		});

		expect(released).toMatchObject({ ok: true });
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.trees ?? []).toHaveLength(0);
	});

	it("lets go of an adopted tree without force, leaving its folder", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature H");
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-adopt",
			cwd: repoRoot,
			force: true,
		});

		const released = succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "tree-release",
				cwd: repoRoot,
			}),
		);

		expect(released.message).toContain("folder stays");
		expect(released.message).not.toContain("work release");
		expect(
			existsSync(join(repoRoot, ".git")),
			`${join(repoRoot, ".git")} is kept`,
		).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		expect(fm?.trees ?? []).toHaveLength(0);
	});

	it("names the work release that gives back an adopted work tree", async () => {
		const saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = join(tmpRoot, "state");
		try {
			const trees = join(
				tmpRoot,
				"state",
				"pi",
				"agentic-harness.pi",
				"work",
				"trees",
			);
			mkdirSync(trees, { recursive: true });
			const cut = join(trees, "worktree-github-someone-repo-a-branch");
			renameSync(repoRoot, cut);
			repoRoot = cut;
			const state = buildState();
			await createQuest(state, "Feature I");
			await handle(state, fakePi(), fakeCtx(cut), {
				action: "tree-adopt",
				cwd: cut,
				force: true,
			});

			const released = succeeded(
				await handle(state, fakePi(), fakeCtx(tmpRoot), {
					action: "tree-release",
					cwd: cut,
				}),
			);

			expect(released.message).toContain(
				"`work release` with tree worktree-github-someone-repo-a-branch",
			);
			expect(existsSync(cut), `${cut} is kept`).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = saved;
		}
	});

	it("still deletes an adopted tree's folder when forced", async () => {
		const state = buildState();
		const q = await createQuest(state, "Feature J");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "adopted-later",
			cwd: repoRoot,
		});
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		mutateQuestFrontMatter(dirname(q.path), (fm) => ({
			...fm,
			trees: (fm.trees ?? []).map((t) => ({
				...t,
				origin: "adopted" as const,
			})),
		}));

		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "tree-release",
				cwd: treePath,
				force: true,
			}),
		);

		expect(existsSync(treePath), `${treePath} is removed`).toBe(false);
	});
});

describe("a quest shared with another machine", () => {
	// As the share shows optimus's quest on a Mac: one tree the Mac cut,
	// one optimus cut, whose path reads as a folder the Mac hasn't got,
	// and one from before trees named their machine.
	const theirs = "/Users/someone/.local/state/work/trees/their-branch";
	const legacy = "/Users/someone/.local/state/work/trees/from-before";
	async function sharedQuest(state: ReturnType<typeof buildState>) {
		const q = await createQuest(state, "Shared");
		await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "ours",
			cwd: repoRoot,
		});
		const written = mutateQuestFrontMatter(dirname(q.path), (fm) => ({
			...fm,
			trees: [
				...(fm.trees ?? []),
				{
					path: theirs,
					providerId: "git-worktree",
					origin: "scaffolded",
					host: "far-machine",
				},
				{ path: legacy, providerId: "git-worktree", origin: "scaffolded" },
			],
		}));
		if (!written.ok) throw new Error(written.guidance);
		return q;
	}
	const treesOf = (path: string) =>
		parseQuestFrontMatter(readFileSync(path, "utf8"))?.frontMatter.trees ?? [];

	it("lists every tree, saying which aren't this machine's", async () => {
		const state = buildState();
		await sharedQuest(state);

		const listed = succeeded(
			await handle(state, fakePi(), fakeCtx(repoRoot), { action: "tree-list" }),
		);

		expect(listed.message).toMatch(
			/3 trees .*1 on another machine, 1 not on this machine/,
		);
		const places = (listed.details as { trees: { place: string }[] }).trees.map(
			(tree) => tree.place,
		);
		expect(places).toEqual(["here", "elsewhere", "unplaced"]);
	});

	it("names this machine on the tree it cuts", async () => {
		const state = buildState();
		const q = await sharedQuest(state);

		expect(treesOf(q.path)[0]?.host).toBe(hostname());
	});

	it("never releases another machine's tree, nor drops its record", async () => {
		const state = buildState();
		const q = await sharedQuest(state);

		const released = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-release",
			cwd: theirs,
			force: true,
		});

		expect(released).toMatchObject({ ok: false });
		if (!released.ok) expect(released.guidance).toMatch(/is on far-machine/);
		expect(treesOf(q.path).map((tree) => tree.path)).toContain(theirs);
	});

	it("asks for force before dropping a tree it can't place", async () => {
		const state = buildState();
		const q = await sharedQuest(state);

		const asked = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-release",
			cwd: legacy,
		});
		expect(asked).toMatchObject({ ok: false });
		if (!asked.ok) expect(asked.guidance).toMatch(/names no machine/);
		expect(treesOf(q.path).map((tree) => tree.path)).toContain(legacy);

		const dropped = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-release",
			cwd: legacy,
			force: true,
		});
		expect(dropped).toMatchObject({ ok: true });
		expect(treesOf(q.path).map((tree) => tree.path)).not.toContain(legacy);
	});

	it("retires pruning only this machine's trees, leaving the rest listed", async () => {
		const state = buildState();
		const q = await sharedQuest(state);

		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			id: q.id,
			reason: "testing a shared quest's trees",
		});

		expect(retired).toMatchObject({ ok: true });
		expect(treesOf(q.path).map((tree) => tree.path)).toEqual([theirs, legacy]);
	});
});

describe("tree-release attached-session refusal", () => {
	it("refuses when a session is attached inside the tree", async () => {
		const state = buildState();
		await createQuest(state, "Feature S");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-s",
			cwd: repoRoot,
		});
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		const attachResult = await handle(
			state,
			fakePi(),
			fakeCtx(treePath, "sess-inside"),
			{ action: "session-attach", cwd: treePath },
		);
		expect(attachResult).toMatchObject({ ok: true });
		const pruned = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-release",
			target: treePath,
		});
		expect(pruned).toMatchObject({ ok: false });
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
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			id: state.questId ?? "",
			reason: "done with it",
		});
		expect(retired).toMatchObject({ ok: true });
		if (retired.ok) {
			const details = retired.details as {
				prunedTrees: string[];
				blockedTrees: { path: string }[];
			};
			expect(details.prunedTrees).toContain(treePath);
			expect(details.blockedTrees).toHaveLength(0);
		}
		expect(existsSync(treePath), `${treePath} is removed`).toBe(false);
	});

	it("surfaces blocked trees as manual resolution on retire", async () => {
		const state = buildState();
		await createQuest(state, "Retire Dirty");
		const added = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "tree-add",
			name: "feature-dirty",
			cwd: repoRoot,
		});
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		writeFileSync(join(treePath, "dirt"), "x");
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			id: state.questId ?? "",
			reason: "wrap up",
		});
		expect(retired).toMatchObject({ ok: true });
		if (retired.ok) {
			const details = retired.details as {
				prunedTrees: string[];
				blockedTrees: { path: string }[];
			};
			expect(details.prunedTrees).toHaveLength(0);
			expect(details.blockedTrees.map((b) => b.path)).toContain(treePath);
			// One tree, so the verb agrees with it. The message said "1 tree(s) need"
			// until the counting went through the shared pluralizer.
			expect(retired.message).toMatch(/1 tree needs manual resolution/);
		}
		expect(existsSync(treePath), `${treePath} is kept`).toBe(true);
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
		const path1 = (succeeded(t1).details as { tree: { path: string } }).tree
			.path;
		const path2 = (succeeded(t2).details as { tree: { path: string } }).tree
			.path;
		writeFileSync(join(path1, "dirt"), "x");
		writeFileSync(join(path2, "dirt"), "x");
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			id: state.questId ?? "",
			reason: "both still pending",
		});
		expect(retired).toMatchObject({ ok: true });
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
		const treePath = (succeeded(added).details as { tree: { path: string } })
			.tree.path;
		await handle(state, fakePi(), fakeCtx(treePath, "sess-live"), {
			action: "session-attach",
			cwd: treePath,
		});
		const retired = await handle(state, fakePi(), fakeCtx(repoRoot), {
			action: "retire",
			id: state.questId ?? "",
			reason: "see you later",
		});
		expect(retired).toMatchObject({ ok: true });
		expect(existsSync(treePath), `${treePath} is kept`).toBe(true);
		const fm = parseQuestFrontMatter(readFileSync(q.path, "utf8"))?.frontMatter;
		const pending = fm?.pendingPrune ?? [];
		expect(pending.find((e) => e.path === treePath)?.reason).toMatch(
			/attached session/,
		);
	});
});

describe("tree-expand of a tree the quest has not recorded", () => {
	/** A provider that expands by recording what it was asked. */
	function recordingExpands(): Array<{ path: string; zone: string }> {
		const seen: Array<{ path: string; zone: string }> = [];
		registerTreeProvider({
			id: "recording",
			// Ahead of the built-in git-worktree's 100: the lowest wins.
			priority: 1,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "recording" }),
			release: async () => {},
			expand: async (input: { path: string; zone: string }) => {
				seen.push(input);
			},
		} as TreeProvider);
		return seen;
	}

	/** A linked worktree of the fixture repo, which only this test made. */
	async function linkedTree(): Promise<string> {
		const path = join(tmpRoot, "linked");
		await git(repoRoot, "worktree", "add", "-q", "-b", "linked", path);
		return realpathSync(path);
	}

	function treesOf(questPath: string): string[] {
		return (
			parseQuestFrontMatter(readFileSync(questPath, "utf8"))?.frontMatter
				.trees ?? []
		).map((t) => t.path);
	}

	it("adopts it, then expands it, in one call", async () => {
		const seen = recordingExpands();
		const linked = await linkedTree();
		const state = buildState();
		const q = await createQuest(state, "Expand Adopts");

		const result = succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "tree-expand",
				cwd: linked,
				ref: "system/gitstream",
			}),
		);

		expect(result.message).toContain("Adopted");
		expect(seen).toEqual([{ path: linked, zone: "system/gitstream" }]);
		expect(treesOf(q.path)).toEqual([linked]);
	});

	it("adopts it beside the trees the quest already holds", async () => {
		const seen = recordingExpands();
		const linked = await linkedTree();
		const state = buildState();
		const q = await createQuest(state, "Expand Beside");
		const other = join(tmpRoot, "other");
		addTreeToQuest(dirname(q.path), {
			path: other,
			providerId: "recording",
			repoRoot: other,
			origin: "scaffolded",
		});

		succeeded(
			await handle(state, fakePi(), fakeCtx(tmpRoot), {
				action: "tree-expand",
				cwd: linked,
				ref: "system/gitstream",
			}),
		);

		expect(seen).toEqual([{ path: linked, zone: "system/gitstream" }]);
		expect(treesOf(q.path)).toEqual([other, linked]);
	});

	it("refuses one another quest holds, expanding nothing", async () => {
		const seen = recordingExpands();
		const linked = await linkedTree();
		const holder = buildState();
		const held = await createQuest(holder, "Holds It");
		addTreeToQuest(dirname(held.path), {
			path: linked,
			providerId: "recording",
			repoRoot: linked,
			origin: "adopted",
		});
		const state = buildState();
		const q = await createQuest(state, "Wants It");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-expand",
			cwd: linked,
			ref: "system/gitstream",
		});

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.guidance).toContain(held.id);
		expect(seen).toEqual([]);
		expect(treesOf(q.path)).toEqual([]);
	});

	it("refuses a repository's main working tree, expanding nothing", async () => {
		const seen = recordingExpands();
		const state = buildState();
		const q = await createQuest(state, "Main Tree");

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-expand",
			cwd: repoRoot,
			ref: "system/gitstream",
		});

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.guidance).toMatch(/main working tree/);
		expect(seen).toEqual([]);
		expect(treesOf(q.path)).toEqual([]);
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
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.guidance).toMatch(/does not support expand/);
		}
	});
});
