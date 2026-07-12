import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadQuest,
	resolveStartup,
} from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import { createEnvGuard } from "./_helpers";

function addTree(
	id: string,
	treePath: string,
	origin: "scaffolded" | "adopted",
): void {
	mkdirSync(treePath, { recursive: true });
	const readme = join(tmpRoot, "quests", id, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(readme, "utf8"));
	if (!parsed) throw new Error("unreadable quest");
	parsed.frontMatter.trees = [
		...(parsed.frontMatter.trees ?? []),
		{ path: treePath, providerId: "git-worktree", origin },
	];
	writeFileSync(
		readme,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}

// A ctx whose session history carries a persisted loaded-quest slice,
// the shape restore() reads on a /reload.
function ctxWith(opts: {
	cwd: string;
	sessionId?: string;
	persistedQuestId?: string;
}) {
	const entries = opts.persistedQuestId
		? [
				{
					type: "custom",
					customType: "quest-workflow",
					data: { questId: opts.persistedQuestId },
				},
			]
		: [];
	return {
		cwd: opts.cwd,
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "sess-1",
			isPersisted: () => true,
			getEntries: () => entries,
		},
	} as unknown as Parameters<typeof resolveStartup>[2];
}

function buildState(opts?: { autoloadFromCwd?: boolean }) {
	return createQuestState({
		questsRoot: join(tmpRoot, "quests"),
		autoloadFromCwd: opts?.autoloadFromCwd,
	});
}

async function createQuest(title: string): Promise<string> {
	const state = buildState();
	const result = await handle(state, fakePi(), ctxWith({ cwd: tmpRoot }), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "resolve-startup-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
	delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("resolveStartup precedence", () => {
	it("lets an explicit spawn request win over persisted history", async () => {
		const requested = await createQuest("Requested");
		const persisted = await createQuest("Persisted");
		process.env.QUEST_WORKFLOW_AUTOLOAD_ID = requested;

		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot, persistedQuestId: persisted }),
		);

		expect(resolution.source).toBe("explicit");
		expect(resolution.questId).toBe(requested);
		// The env var is consumed so it never carries across a restart.
		expect(process.env.QUEST_WORKFLOW_AUTOLOAD_ID).toBeUndefined();
	});

	it("falls back to persisted history when there is no explicit request", async () => {
		const persisted = await createQuest("Persisted");
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot, persistedQuestId: persisted }),
		);

		expect(resolution.source).toBe("persisted");
		expect(resolution.questId).toBe(persisted);
	});

	it("reports none when nothing resolves", () => {
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot }),
		);
		expect(resolution.source).toBe("none");
		expect(resolution.questId).toBeNull();
	});

	it("resolves from the cwd when nothing else matches and cwd autoload is on", async () => {
		const id = await createQuest("Cwd Match");
		const questDir = join(tmpRoot, "quests", id);
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: questDir }),
		);
		expect(resolution.source).toBe("cwd");
		expect(resolution.questId).toBe(id);
	});

	it("stays idle on a fresh session in a quest dir when cwd autoload is off", async () => {
		const id = await createQuest("Cwd Match Off");
		const questDir = join(tmpRoot, "quests", id);
		const state = buildState({ autoloadFromCwd: false });
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: questDir }),
		);
		expect(resolution.source).toBe("none");
		expect(resolution.questId).toBeNull();
	});

	it("still honours persisted history when cwd autoload is off", async () => {
		const persisted = await createQuest("Persisted Off");
		const state = buildState({ autoloadFromCwd: false });
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot, persistedQuestId: persisted }),
		);
		expect(resolution.source).toBe("persisted");
		expect(resolution.questId).toBe(persisted);
	});

	// Keep loadQuest referenced so the import contract is exercised.
	it("loadQuest resolves a known id", async () => {
		const id = await createQuest("Known");
		const state = buildState();
		expect(loadQuest(state, fakePi(), id).ok).toBe(true);
	});

	it("resolves from a scaffolded tree the quest owns", async () => {
		const id = await createQuest("Scaffolded Tree");
		const treePath = join(tmpRoot, "work", "scaffolded");
		addTree(id, treePath, "scaffolded");
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: treePath }),
		);
		expect(resolution.source).toBe("cwd");
		expect(resolution.questId).toBe(id);
	});

	it("never auto-loads from an adopted tree", async () => {
		const id = await createQuest("Adopted Tree");
		const treePath = join(tmpRoot, "work", "adopted");
		addTree(id, treePath, "adopted");
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: treePath }),
		);
		expect(resolution.source).toBe("none");
		expect(resolution.questId).toBeNull();
	});
});
