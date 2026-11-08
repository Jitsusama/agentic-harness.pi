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

/** Record session `id` on quest `questId`'s README, as attach writes it. */
function addSession(
	questId: string,
	id: string,
	status: "active" | "detached",
	started = "2026-11-08T03:50:51.938Z",
): void {
	const readme = join(tmpRoot, "quests", questId, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(readme, "utf8"));
	if (!parsed) throw new Error("unreadable quest");
	parsed.frontMatter.sessions = [
		...parsed.frontMatter.sessions,
		{ id, started, status, instanceId: "00dee25f-first-pi" },
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
	// Created by a session of its own, which create lists on the quest,
	// so the session each test starts is a stranger to it.
	const creator = ctxWith({ cwd: tmpRoot, sessionId: "creator" });
	const result = await handle(state, fakePi(), creator, {
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
	delete process.env.QUEST_WORKFLOW_ORCHESTRATE;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
	delete process.env.QUEST_WORKFLOW_ORCHESTRATE;
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

	// 11-07 22:50: a spawned pi was killed before it wrote any history, and
	// the pi resumed on its log at 23:15 loaded no quest, so its end never
	// let go of the quest's entry and cadence started it again (80ECO2).
	it("resumes onto the quest whose README lists the session, when its log never said", async () => {
		const drill = await createQuest("Drill");
		const other = await createQuest("Other");
		addSession(drill, "01a1b947", "active");
		addSession(other, "01a1b947", "detached", "2026-11-08T04:00:00.000Z");
		const state = buildState({ autoloadFromCwd: false });
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot, sessionId: "01a1b947" }),
		);
		expect(resolution.source).toBe("record");
		expect(resolution.questId).toBe(drill);
	});

	it("lets the log's own history win over the README's", async () => {
		const listed = await createQuest("Listed");
		const persisted = await createQuest("Persisted Over Listed");
		addSession(listed, "sess-1", "active");
		const state = buildState();
		const resolution = resolveStartup(
			state,
			fakePi(),
			ctxWith({ cwd: tmpRoot, persistedQuestId: persisted }),
		);
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

describe("a session the launcher starts to orchestrate", () => {
	const marked = (id: string) =>
		parseQuestFrontMatter(
			readFileSync(join(tmpRoot, "quests", id, "README.md"), "utf8"),
		)?.frontMatter.orchestrator === true;

	it("marks the quest it autoloads as orchestrating, once, and forgets the ask", async () => {
		const id = await createQuest("Never Orchestrated");
		process.env.QUEST_WORKFLOW_AUTOLOAD_ID = id;
		process.env.QUEST_WORKFLOW_ORCHESTRATE = "1";

		resolveStartup(buildState(), fakePi(), ctxWith({ cwd: tmpRoot }));

		expect(marked(id)).toBe(true);
		expect(process.env.QUEST_WORKFLOW_ORCHESTRATE).toBeUndefined();
	});

	it("marks nothing when the autoload fails, nor a quest it resolves another way", async () => {
		const persisted = await createQuest("Persisted");
		process.env.QUEST_WORKFLOW_AUTOLOAD_ID = "QEST-20260101-NOSUCH";
		process.env.QUEST_WORKFLOW_ORCHESTRATE = "1";

		const resolution = resolveStartup(
			buildState(),
			fakePi(),
			ctxWith({ cwd: tmpRoot, persistedQuestId: persisted }),
		);

		expect(resolution.questId).toBe(persisted);
		expect(marked(persisted)).toBe(false);
		expect(process.env.QUEST_WORKFLOW_ORCHESTRATE).toBeUndefined();
	});

	it("marks nothing without the ask", async () => {
		const id = await createQuest("Plain");
		process.env.QUEST_WORKFLOW_AUTOLOAD_ID = id;

		resolveStartup(buildState(), fakePi(), ctxWith({ cwd: tmpRoot }));

		expect(marked(id)).toBe(false);
	});
});
