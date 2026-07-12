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
import { recentSessions } from "../../../extensions/quest-workflow/lookup";
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

function attachSessions(
	id: string,
	sessions: { id: string; cwd?: string }[],
): void {
	const path = join(tmpRoot, "quests", id, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error("unreadable");
	parsed.frontMatter.sessions = sessions.map((s) => ({
		id: s.id,
		started: new Date().toISOString(),
		status: "active" as const,
		...(s.cwd ? { cwd: s.cwd } : {}),
	}));
	writeFileSync(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}

// A session log whose newest timestamp is now, so the session reads
// live, optionally naming the quest it last loaded.
function writeLiveSessionLog(sessionId: string, questId?: string): void {
	const dir = join(sessionsDir(), "--recent-test--");
	mkdirSync(dir, { recursive: true });
	const lines = [JSON.stringify({ timestamp: new Date().toISOString() })];
	if (questId) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "quest-workflow",
				data: { questId },
			}),
		);
	}
	writeFileSync(
		join(dir, `2026-06-04T10-00-00-000Z_${sessionId}.jsonl`),
		lines.join("\n"),
	);
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "recent-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("recentSessions", () => {
	it("lists sessions across quests, including a crashed one workspace would drop", async () => {
		const state = buildState();
		const live = await createQuest(state, "Live Quest");
		const crashed = await createQuest(state, "Crashed Quest");
		attachSessions(live, [{ id: "sess-live", cwd: "/work/live" }]);
		writeLiveSessionLog("sess-live");
		// No log for sess-dead, so it derives dead: the recoverable crash.
		attachSessions(crashed, [{ id: "sess-dead", cwd: "/work/crashed" }]);

		const rows = await recentSessions(state);
		const bySession = new Map(rows.map((r) => [r.sessionId, r]));
		expect(bySession.get("sess-live")).toMatchObject({
			questId: live,
			liveness: "live",
			cwd: "/work/live",
		});
		expect(bySession.get("sess-dead")).toMatchObject({
			questId: crashed,
			liveness: "dead",
			cwd: "/work/crashed",
		});
	});

	it("shows one row per session, resolving a many-quest claim to its log's owner", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		attachSessions(a, [{ id: "sess-x" }]);
		attachSessions(b, [{ id: "sess-x" }]);
		// The session's log names Bravo as its true owner.
		writeLiveSessionLog("sess-x", b);

		const rows = await recentSessions(state);
		const forX = rows.filter((r) => r.sessionId === "sess-x");
		expect(forX).toHaveLength(1);
		expect(forX[0].questId).toBe(b);
	});

	it("is reachable through the recent verb", async () => {
		const state = buildState();
		const q = await createQuest(state, "Recent Quest");
		attachSessions(q, [{ id: "sess-live" }]);
		writeLiveSessionLog("sess-live");
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "recent",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain(q);
	});
});
