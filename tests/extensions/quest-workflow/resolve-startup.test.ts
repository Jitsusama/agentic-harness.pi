import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadQuest,
	resolveStartup,
} from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard } from "./_helpers";

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

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
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

	// Keep loadQuest referenced so the import contract is exercised.
	it("loadQuest resolves a known id", async () => {
		const id = await createQuest("Known");
		const state = buildState();
		expect(loadQuest(state, fakePi(), id).ok).toBe(true);
	});
});
