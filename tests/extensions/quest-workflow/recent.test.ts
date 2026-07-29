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
	recentSessionHints,
	recentSessions,
} from "../../../extensions/quest-workflow/lookup";
import { saveRecord } from "../../../extensions/quest-workflow/session-registry";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { sessionsDir } from "../../../lib/internal/paths";
import {
	closeRecord,
	openRecord,
} from "../../../lib/internal/quest/session-registry";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import { createEnvGuard, succeeded } from "./_helpers";

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

// A session log whose newest timestamp is `at` (default now), so the
// session reads live, optionally naming the quest it last loaded.
function writeLiveSessionLog(
	sessionId: string,
	questId?: string,
	at: string = new Date().toISOString(),
): void {
	const dir = join(sessionsDir(), "--recent-test--");
	mkdirSync(dir, { recursive: true });
	const lines = [JSON.stringify({ timestamp: at })];
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
let savedState: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "recent-"));
	savedHome = process.env.HOME;
	savedState = process.env.XDG_STATE_HOME;
	process.env.HOME = tmpRoot;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	if (savedState !== undefined) process.env.XDG_STATE_HOME = savedState;
	else delete process.env.XDG_STATE_HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** Put a record straight into the registry, bypassing a live load. */
function record(input: {
	sessionId: string;
	questId: string;
	cwd?: string;
	lost?: boolean;
	quit?: boolean;
}) {
	const open = openRecord({
		sessionId: input.sessionId,
		instanceId: `inst-${input.sessionId}`,
		cwd: input.cwd ?? "/work",
		questId: input.questId,
		now: new Date("2026-07-28T18:00:00.000Z"),
	});
	if (input.lost)
		return saveRecord(
			closeRecord(open, "died", new Date("2026-07-28T18:30:00.000Z")),
		);
	if (input.quit)
		return saveRecord(
			closeRecord(open, "quit", new Date("2026-07-28T18:30:00.000Z")),
		);
	return saveRecord(open);
}

describe("recentSessions", () => {
	it("lists sessions across quests, including one lost to a crash", async () => {
		const state = buildState();
		const open = await createQuest(state, "Open Quest");
		const crashed = await createQuest(state, "Crashed Quest");
		record({ sessionId: "sess-open", questId: open, cwd: "/work/open" });
		record({
			sessionId: "sess-dead",
			questId: crashed,
			cwd: "/work/crashed",
			lost: true,
		});

		const { rows } = await recentSessions(state);
		const bySession = new Map(rows.map((r) => [r.sessionId, r]));
		// Open but unprobeable reads idle, not dead: nothing was captured
		// to probe, and an inability to observe is not evidence of death.
		expect(bySession.get("sess-open")).toMatchObject({
			questId: open,
			liveness: "idle",
			cwd: "/work/open",
		});
		expect(bySession.get("sess-dead")).toMatchObject({
			questId: crashed,
			liveness: "dead",
			cwd: "/work/crashed",
		});
	});

	it("shows one row per session however many quests it has visited", async () => {
		// The old listing read each session's log to decide which quest
		// owned it, because two quests could both claim it. A record
		// names one quest, so the divergence cannot be written down.
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		record({ sessionId: "sess-x", questId: a });
		record({ sessionId: "sess-x", questId: b });

		const { rows } = await recentSessions(state);
		const forX = rows.filter((r) => r.sessionId === "sess-x");
		expect(forX).toHaveLength(1);
		expect(forX[0].questId).toBe(b);
	});

	it("says how many it left out rather than trimming in silence", async () => {
		// A capped listing that says nothing looks exactly like a
		// complete one, so the session you wanted is missing with no
		// sign that anything was cut.
		const state = buildState();
		const q = await createQuest(state, "Busy Quest");
		for (let i = 0; i < 15; i++) {
			record({ sessionId: `sess-${i}`, questId: q });
		}
		const { rows, total } = await recentSessions(state);
		expect(total).toBe(15);
		expect(rows).toHaveLength(12);

		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "recent",
		});
		expect(succeeded(result).message).toContain("Showing 12 of 15 sessions");
	});

	it("is reachable through the recent verb", async () => {
		const state = buildState();
		const q = await createQuest(state, "Recent Quest");
		record({ sessionId: "sess-live", questId: q });
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "recent",
		});
		expect(succeeded(result).message).toContain(q);
	});
});

describe("recentSessionHints", () => {
	it("orders sessions newest activity first without probing", async () => {
		const state = buildState();
		const older = await createQuest(state, "Older");
		const newer = await createQuest(state, "Newer");
		attachSessions(older, [{ id: "sess-old", cwd: "/w/old" }]);
		attachSessions(newer, [{ id: "sess-new", cwd: "/w/new" }]);
		writeLiveSessionLog("sess-old", undefined, "2026-06-01T00:00:00.000Z");
		writeLiveSessionLog("sess-new", undefined, "2026-06-10T00:00:00.000Z");

		const hints = recentSessionHints(state);
		expect(hints.map((h) => h.sessionId)).toEqual(["sess-new", "sess-old"]);
		expect(hints[0]).toMatchObject({ questId: newer, cwd: "/w/new" });
	});

	it("caps the list and omits sessions with no log activity", async () => {
		const state = buildState();
		const q = await createQuest(state, "Quest");
		attachSessions(q, [{ id: "sess-logged" }, { id: "sess-silent" }]);
		writeLiveSessionLog("sess-logged");
		const hints = recentSessionHints(state, 5);
		expect(hints.map((h) => h.sessionId)).toEqual(["sess-logged"]);
	});
});
