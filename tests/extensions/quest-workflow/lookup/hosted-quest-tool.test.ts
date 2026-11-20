/**
 * The quest tool on a host, whose discovery answers a known tree from
 * its last walk for a few seconds: each action reads the quests it
 * names again first, and waits on the whole tree signed afresh when
 * what it writes rests on quests it doesn't name, or the last walk is
 * over a minute old, so what it reads and decides on is the tree as it
 * stands. None of that walking happens on the host's thread.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BudgetKeeper } from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { followSessionLife } from "../../../../extensions/quest-workflow/wiring/session.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import { settle } from "../../../lib/internal/quest/support/discovery-tree.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { installTestHost } from "../../../support/session-host.ts";
import { createEnvGuard, fakeCtx } from "../_helpers.ts";

// Reads on the thread are counted, to show the walk isn't one.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		readFileSync: vi.fn(actual.readFileSync),
		statSync: vi.fn(actual.statSync),
		lstatSync: vi.fn(actual.lstatSync),
	};
});
/** A read counted on the thread, as these tests ask of it. */
interface Counted {
	readonly mock: { readonly calls: readonly (readonly unknown[])[] };
	mockClear(): void;
}
const onThread: readonly Counted[] = [
	vi.mocked(readdirSync),
	vi.mocked(readFileSync),
	vi.mocked(statSync),
	vi.mocked(lstatSync),
];

/** The paths read on the thread since `onThread` was last cleared. */
function readOnThread(): string[] {
	return onThread.flatMap((read) =>
		read.mock.calls.map(([path]) => String(path)),
	);
}

const envGuard = createEnvGuard();
let tmpRoot: string;
let host: ReturnType<typeof installTestHost>;

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "hosted-quest-tool-"));
	clearDiscoveryCache();
	host = installTestHost();
});

afterEach(() => {
	vi.restoreAllMocks();
	host.dispose();
	clearDiscoveryCache();
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** Date everything under `path` well before now, as a settled tree is. */
function settleAll(path: string): void {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const inner = join(path, entry.name);
		if (entry.isDirectory()) settleAll(inner);
		else settle(inner);
	}
	settle(path);
}

/** A quest made through the tool, by a state of its own. */
async function made(
	questsRoot: string,
	title: string,
	parent?: string,
): Promise<{ id: string; readme: string }> {
	const state = createQuestState({ questsRoot });
	const kind = parent ? "subquest" : undefined;
	const result = await withSession("a", () =>
		handle(state, fakePi(), fakeCtx(tmpRoot, "a"), {
			action: "create",
			title,
			parent,
			kind,
		}),
	);
	if (!result.ok) throw new Error(result.guidance);
	const id = state.questId ?? "";
	return { id, readme: join(state.questDir ?? "", "README.md") };
}

/** Give a quest a parent as another process would: on disk, uncounted. */
function parentedElsewhere(readmePath: string, parent: string): void {
	const text = readFileSync(readmePath, "utf8").replace(
		/^kind: quest$/m,
		"kind: subquest",
	);
	const next = /^parent:/m.test(text)
		? text.replace(/^parent:.*$/m, `parent: ${parent}`)
		: text.replace(/^kind: subquest$/m, `kind: subquest\nparent: ${parent}`);
	writeFileSync(readmePath, next);
	settle(readmePath);
}

/**
 * Add `yaml`, whole lines, to a quest's frontmatter as another process
 * would: on disk, uncounted, in place of an empty list of the same key.
 */
function frontMatterElsewhere(readmePath: string, yaml: string): void {
	const key = yaml.slice(0, yaml.indexOf(":"));
	const text = readFileSync(readmePath, "utf8")
		.replace(new RegExp(`^${key}: \\[\\]\\n`, "m"), "")
		.replace(/\n---\n/, `\n${yaml}---\n`);
	writeFileSync(readmePath, text);
	settle(readmePath);
}

/** Move the clock past how old a walk an action acts on may be. */
function aMinuteOn(): void {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
}

it("refuses a cycle through a quest the action doesn't name, made elsewhere since", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const gamma = await made(questsRoot, "Gamma");
	const beta = await made(questsRoot, "Beta", gamma.id);
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(
		beta.id,
	);

	parentedElsewhere(gamma.readme, alpha.id);
	const state = createQuestState({ questsRoot });
	const result = await withSession("a", () =>
		handle(state, fakePi(), fakeCtx(tmpRoot, "a"), {
			action: "reparent",
			id: alpha.id,
			parent: beta.id,
		}),
	);

	expect(result.ok, "Alpha under Beta, under Gamma, under Alpha").toBe(false);
	expect(readFileSync(alpha.readme, "utf8")).not.toContain(beta.id);
});

it("refuses an alias another process put on another quest since the last walk", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const beta = await made(questsRoot, "Beta");
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(
		beta.id,
	);

	frontMatterElsewhere(
		beta.readme,
		"aliases:\n  - type: github-pr\n    value: shop/world#1\n",
	);
	const before = readFileSync(alpha.readme, "utf8");
	const state = createQuestState({ questsRoot });
	const result = await withSession("a", () =>
		handle(state, fakePi(), fakeCtx(tmpRoot, "a"), {
			action: "alias-add",
			id: alpha.id,
			ref: "github-pr:shop/world#1",
		}),
	);

	expect(result.ok ? "added" : result.guidance).toContain(beta.id);
	expect(readFileSync(alpha.readme, "utf8")).toBe(before);
});

it("starts a session in a tree another process gave a quest since the last walk", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const beta = await made(questsRoot, "Beta");
	const tree = join(tmpRoot, "tree");
	mkdirSync(tree);
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(
		beta.id,
	);

	frontMatterElsewhere(
		beta.readme,
		`trees:\n  - path: ${tree}\n    providerId: git-worktree\n` +
			`    repoRoot: ${tree}\n    origin: scaffolded\n`,
	);
	const walked = discoverQuests(questsRoot).index.quests.get(beta.id);
	expect(walked?.doc.frontMatter.trees ?? [], "the last walk").toEqual([]);
	const state = createQuestState({ questsRoot });
	const pi = fakePi();
	const budgets = { keep: async () => undefined, forget: () => undefined };
	followSessionLife(pi, state, budgets as unknown as BudgetKeeper, undefined);
	const [start] = pi.recorded.handlers.get("session_start") ?? [];
	for (const read of onThread) read.mockClear();
	await withSession("a", async () =>
		start?.({ type: "session_start", reason: "startup" }, startIn(tree)),
	);

	expect(state.questId).toBe(beta.id);
	const elsewhere = dirname(alpha.readme);
	const read = readOnThread().filter((path) => path.startsWith(elsewhere));
	expect(read, "a quest it didn't start in, read on the thread").toEqual([]);
});

/** A session's context at its start in `cwd`, kept in no file. */
function startIn(cwd: string): unknown {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		// A screen nobody sees: every call to it is taken and does nothing.
		ui: new Proxy({}, { get: () => () => undefined }),
		sessionManager: {
			getSessionId: () => "a",
			isPersisted: () => false,
			getEntries: () => [],
			getBranch: () => [],
		},
	};
}

it("finds a document another process made in another quest since the last walk", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const beta = await made(questsRoot, "Beta");
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(
		beta.id,
	);

	const planId = "PLAN-20260604-CCC333";
	const plans = join(beta.readme, "..", "plans");
	mkdirSync(plans, { recursive: true });
	const planPath = join(plans, `${planId}.md`);
	writeFileSync(
		planPath,
		`---\nid: ${planId}\nkind: plan\nquest: ${beta.id}\nstage: think\n` +
			"updated: 2026-06-04\n---\n\n# Made Elsewhere\n",
	);
	settle(planPath);
	const state = createQuestState({ questsRoot });
	state.questId = alpha.id;
	const shown = await withSession("a", () =>
		handle(state, fakePi(), fakeCtx(tmpRoot, "a"), {
			action: "show",
			id: planId,
		}),
	);

	expect(shown.ok ? "shown" : shown.guidance).toBe("shown");
});

it("acts on the whole tree as it stands after a minute unasked", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const beta = await made(questsRoot, "Beta");
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(
		beta.id,
	);

	const text = readFileSync(beta.readme, "utf8");
	writeFileSync(
		beta.readme,
		text.replace(/^priority: \w+$/m, "priority: queued"),
	);
	settle(beta.readme);
	aMinuteOn();
	const state = createQuestState({ questsRoot });
	state.questId = alpha.id;
	const listed = await withSession("a", () =>
		handle(state, fakePi(), fakeCtx(tmpRoot, "a"), { action: "list" }),
	);

	if (!listed.ok) throw new Error(listed.guidance);
	const { listing } = listed.details as {
		listing: { rows: { id: string; priority: string }[] };
	};
	expect(listing.rows.find((row) => row.id === beta.id)?.priority).toBe(
		"queued",
	);
});

it("reads the tree as it stands at each action, not the host's last walk", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const state = createQuestState({ questsRoot });
	const ctx = fakeCtx(tmpRoot, "a");
	const created = await withSession("a", () =>
		handle(state, fakePi(), ctx, { action: "create", title: "Alpha" }),
	);
	if (!created.ok) throw new Error(created.guidance);
	const id = state.questId ?? "";
	const readmePath = join(state.questDir ?? "", "README.md");
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(id);

	const text = readFileSync(readmePath, "utf8");
	writeFileSync(
		readmePath,
		text.replace(/^priority: \w+$/m, "priority: queued"),
	);
	settle(readmePath);
	const listed = await withSession("a", () =>
		handle(state, fakePi(), ctx, { action: "list" }),
	);

	if (!listed.ok) throw new Error(listed.guidance);
	const { listing } = listed.details as {
		listing: { rows: { id: string; priority: string }[] };
	};
	expect(listing.rows.find((row) => row.id === id)?.priority).toBe("queued");
});

it("runs one message's calls in the order they were made, though the first waits on the tree", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const alpha = await made(questsRoot, "Alpha");
	const beta = await made(questsRoot, "Beta");
	const tree = join(tmpRoot, "tree");
	mkdirSync(tree);
	frontMatterElsewhere(
		beta.readme,
		`trees:\n  - path: ${tree}\n    providerId: git-worktree\n` +
			`    repoRoot: ${tree}\n    origin: scaffolded\n`,
	);
	settleAll(questsRoot);
	discoverQuests(questsRoot);
	const state = createQuestState({ questsRoot });
	const ctx = fakeCtx(tree, "a");
	const loaded = await withSession("a", () =>
		handle(state, fakePi(), ctx, { action: "load", id: alpha.id }),
	);
	if (!loaded.ok) throw new Error(loaded.guidance);

	// As pi runs one message's calls: both asked before either ends. A
	// load naming no quest finds Beta by its tree, from the whole tree.
	const [moved, noted] = await withSession("a", () =>
		Promise.all([
			handle(state, fakePi(), ctx, { action: "load" }),
			handle(state, fakePi(), ctx, { action: "journal", note: "Landed." }),
		]),
	);

	if (!moved.ok) throw new Error(moved.guidance);
	if (!noted.ok) throw new Error(noted.guidance);
	expect(state.questId, "loaded by its tree").toBe(beta.id);
	expect(journeyOf(dirname(beta.readme)), "the quest loaded first").toContain(
		"Landed.",
	);
	expect(journeyOf(dirname(alpha.readme))).not.toContain("Landed.");
});

/** Everything a quest's folder says of its journey: README and JOURNEY.md. */
function journeyOf(dir: string): string {
	return ["README.md", "JOURNEY.md"]
		.map((name) => join(dir, name))
		.filter((file) => existsSync(file))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}
