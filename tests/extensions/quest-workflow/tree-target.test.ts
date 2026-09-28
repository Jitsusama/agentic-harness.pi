import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeProvider } from "@jitsusama/agentic-harness.core/tree";
import {
	clearTreeProviders,
	registerTreeProvider,
} from "@jitsusama/agentic-harness.core/tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter";
import { addTreeToQuest } from "../../../lib/internal/quest/trees";
import { createEnvGuard } from "./_helpers";

// Which tree a verb acts on. A prune deletes a working tree, so a verb
// that lands on a tree nobody named is a destructive bug, not an
// inconvenience: a mistyped path, or a path passed the way every other
// verb takes one, used to fall through to the quest's first tree.

let tmpRoot: string;

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

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-target-"));
	clearTreeProviders();
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
});

interface Recorder {
	pruned: string[];
	expanded: Array<{ path: string; zone: string }>;
}

/** A provider that touches no disk and records what it was asked. */
function recordingProvider(): Recorder {
	const seen: Recorder = { pruned: [], expanded: [] };
	const provider: TreeProvider & {
		expand: (input: { path: string; zone: string }) => Promise<void>;
	} = {
		id: "recording",
		priority: 100,
		appliesTo: () => true,
		create: async () => ({ path: "", providerId: "recording" }),
		prune: async ({ path }) => {
			seen.pruned.push(path);
		},
		expand: async (input) => {
			seen.expanded.push(input);
		},
	};
	registerTreeProvider(provider);
	return seen;
}

/** A loaded quest holding a tree at each of these paths. */
async function questWithTrees(paths: string[]) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		title: "Several Trees",
	});
	if (!created.ok) throw new Error(created.guidance);
	for (const path of paths) {
		addTreeToQuest(state.questDir ?? "", {
			path,
			providerId: "recording",
			repoRoot: path,
			origin: "scaffolded",
		});
	}
	return state;
}

function treesOn(state: { questDir: string | null }): string[] {
	const readme = readFileSync(join(state.questDir ?? "", "README.md"), "utf8");
	return (parseQuestFrontMatter(readme)?.frontMatter.trees ?? []).map(
		(t) => t.path,
	);
}

describe("the tree a prune acts on", () => {
	it("is the one its cwd names, as tree-adopt takes a path", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: second,
		});

		expect(result.ok).toBe(true);
		expect(seen.pruned).toEqual([second]);
		expect(treesOn(state)).toEqual([first]);
	});

	it("is the one holding a path inside it", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: join(second, "src", "lib"),
		});

		expect(result.ok).toBe(true);
		expect(seen.pruned).toEqual([second]);
	});

	it("is found from the tilde form a listing prints", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const home = join(homedir(), ".tree-target-never-created", "second");
		const state = await questWithTrees([first, home]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: "~/.tree-target-never-created/second",
		});

		expect(result.ok).toBe(true);
		expect(seen.pruned).toEqual([home]);
	});

	it("is refused, not guessed, when the path names no tree", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: join(tmpRoot, "third"),
		});

		expect(result.ok).toBe(false);
		expect(seen.pruned).toEqual([]);
		expect(treesOn(state)).toEqual([first, second]);
		if (!result.ok) {
			expect(result.guidance).toContain(first);
			expect(result.guidance).toContain(second);
		}
	});

	it("is refused, not guessed, when none is named and there are several", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
		});

		expect(result.ok).toBe(false);
		expect(seen.pruned).toEqual([]);
		if (!result.ok) expect(result.guidance).toMatch(/cwd/);
	});

	it("is the only one, when none is named and there is one", async () => {
		const seen = recordingProvider();
		const only = join(tmpRoot, "only");
		const state = await questWithTrees([only]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
		});

		expect(result.ok).toBe(true);
		expect(seen.pruned).toEqual([only]);
	});

	it("is the deepest, when one tree sits inside another", async () => {
		const seen = recordingProvider();
		const outer = join(tmpRoot, "repo");
		const inner = join(outer, ".worktrees", "feature");
		const state = await questWithTrees([outer, inner]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: join(inner, "src"),
		});

		expect(result.ok).toBe(true);
		expect(seen.pruned).toEqual([inner]);
	});
});

describe("the tree an expand acts on", () => {
	it("is the one its cwd names", async () => {
		const seen = recordingProvider();
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-expand",
			cwd: second,
			ref: "system/gitstream",
		});

		expect(result.ok).toBe(true);
		expect(seen.expanded).toEqual([{ path: second, zone: "system/gitstream" }]);
	});

	it("reaches the provider that made the tree, not whichever wins today", async () => {
		const expanded: string[] = [];
		registerTreeProvider({
			id: "recording",
			priority: 100,
			appliesTo: () => false,
			create: async () => ({ path: "", providerId: "recording" }),
			prune: async () => {},
			expand: async ({ path }: { path: string }) => {
				expanded.push(path);
			},
		} as TreeProvider);
		registerTreeProvider({
			id: "wrong",
			priority: 1,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "wrong" }),
			prune: async () => {},
		});
		const only = join(tmpRoot, "only");
		const state = await questWithTrees([only]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-expand",
			ref: "system/gitstream",
		});

		expect(result.ok).toBe(true);
		expect(expanded).toEqual([only]);
	});

	it("is refused, not guessed, when none is named and there are several", async () => {
		const seen = recordingProvider();
		const state = await questWithTrees([
			join(tmpRoot, "first"),
			join(tmpRoot, "second"),
		]);

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-expand",
			ref: "system/gitstream",
		});

		expect(result.ok).toBe(false);
		expect(seen.expanded).toEqual([]);
	});
});

describe("quest calls in one parallel batch", () => {
	it("run one at a time, so two prunes of one tree prune it once", async () => {
		// Pi runs the calls of one assistant message concurrently. Two
		// prunes that each read the quest, then awaited the provider,
		// both found the tree still listed and both removed it; the
		// loser's failure was then recorded as a blocked prune against a
		// tree that was already gone.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pruned: string[] = [];
		registerTreeProvider({
			id: "recording",
			priority: 100,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "recording" }),
			prune: async ({ path }) => {
				pruned.push(path);
				await gate;
			},
		});
		const only = join(tmpRoot, "only");
		const state = await questWithTrees([only, join(tmpRoot, "other")]);

		const a = handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: only,
		});
		const b = handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: only,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		const [first, second] = await Promise.all([a, b]);

		expect(pruned).toEqual([only]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
	});

	it("lets a call stopped while it waits leave without running", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pruned: string[] = [];
		registerTreeProvider({
			id: "recording",
			priority: 100,
			appliesTo: () => true,
			create: async () => ({ path: "", providerId: "recording" }),
			prune: async ({ path }) => {
				pruned.push(path);
				await gate;
			},
		});
		const first = join(tmpRoot, "first");
		const second = join(tmpRoot, "second");
		const state = await questWithTrees([first, second]);

		const holding = handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "tree-prune",
			cwd: first,
		});
		const controller = new AbortController();
		const waiting = handle(
			state,
			fakePi(),
			fakeCtx(tmpRoot),
			{ action: "tree-prune", cwd: second },
			controller.signal,
		);
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		release();
		expect((await holding).ok).toBe(true);
		expect(pruned).toEqual([first]);
		expect(treesOn(state)).toEqual([second]);
	});
});
