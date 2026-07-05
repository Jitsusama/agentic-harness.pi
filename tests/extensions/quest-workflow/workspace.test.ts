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
import { workspaceQuests } from "../../../extensions/quest-workflow/lookup";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { sessionsDir } from "../../../lib/internal/paths";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
): Promise<string> {
	const result = await handle(state, fakePi(), fakeCtx(), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

function attachSession(id: string, sessionId: string): void {
	const path = join(tmpRoot, "quests", id, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error("unreadable");
	parsed.frontMatter.sessions = [
		{ id: sessionId, started: new Date().toISOString(), status: "active" },
	];
	writeFileSync(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}

// Write a session log with a current timestamp so deriveLiveness reads
// it as live.
function writeLiveSessionLog(sessionId: string): void {
	const dir = join(sessionsDir(), "--workspace-test--");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-06-04T10-00-00-000Z_${sessionId}.jsonl`),
		JSON.stringify({ timestamp: new Date().toISOString() }),
	);
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "workspace-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("workspaceQuests", () => {
	it("lists a quest with a live session and excludes one with no session activity", async () => {
		const state = buildState();
		const live = await createQuest(state, "Being Worked On");
		const idleOnly = await createQuest(state, "No Live Session");
		attachSession(live, "sess-live");
		writeLiveSessionLog("sess-live");
		// idleOnly gets a session with no log file, so it is dead, not live.
		attachSession(idleOnly, "sess-dead");

		const entries = workspaceQuests(state);
		expect(entries.map((e) => e.questId)).toEqual([live]);
		expect(entries[0]).toMatchObject({
			liveness: "live",
			sessionId: "sess-live",
		});
	});

	it("returns empty when nothing is being worked on", async () => {
		const state = buildState();
		await createQuest(state, "Dormant");
		expect(workspaceQuests(state)).toEqual([]);
	});

	it("is reachable through the workspace verb", async () => {
		const state = buildState();
		const live = await createQuest(state, "Live Quest");
		attachSession(live, "sess-live");
		writeLiveSessionLog("sess-live");
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "workspace",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain(live);
	});
});
