import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	auditSessionMembership,
	planDeadSessions,
	planSessionRepair,
} from "../../../extensions/quest-workflow/lookup";
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
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}
async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const r = await handle(state, fakePi(), fakeCtx(), {
		action: "create",
		title,
	});
	if (!r.ok) throw new Error("create failed");
	return state.questId as string;
}
function makeActive(dir: string, sessionId: string): void {
	const path = join(dir, "README.md");
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
// A session carrying a process identity in the valid pid range but
// almost certainly not running, so a real probe reads it gone. An
// out-of-range pid would draw a ps diagnostic and correctly read
// unknown, not gone.
function makeActiveDeadProcess(dir: string, sessionId: string): void {
	const path = join(dir, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error("unreadable");
	parsed.frontMatter.sessions = [
		{
			id: sessionId,
			started: new Date().toISOString(),
			status: "active",
			process: { hostId: hostname(), pid: 99998, startToken: "gone" },
		},
	];
	writeFileSync(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}
// A legacy session record with no status field at all; older files
// wrote these and the code treats a missing status as active.
function makeActiveNoStatus(dir: string, sessionId: string): void {
	const path = join(dir, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error("unreadable");
	parsed.frontMatter.sessions = [
		{ id: sessionId, started: new Date().toISOString() },
	];
	writeFileSync(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}
function writeLog(sessionId: string, ownerQuestId: string | null): void {
	const dir = join(sessionsDir(), "--repair-test--");
	mkdirSync(dir, { recursive: true });
	const line = JSON.stringify({
		type: "custom",
		customType: "quest-workflow",
		data: { questId: ownerQuestId },
	});
	writeFileSync(join(dir, `2026-06-04T10-00-00-000Z_${sessionId}.jsonl`), line);
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "session-repair-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("auditSessionMembership", () => {
	it("counts a status-less legacy record as an active claim", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		makeActiveNoStatus(join(tmpRoot, "quests", a), "sess-legacy");
		makeActive(join(tmpRoot, "quests", b), "sess-legacy");
		expect(auditSessionMembership(state)).toEqual([
			{ sessionId: "sess-legacy", questIds: [a, b].sort() },
		]);
	});
});

describe("planDeadSessions", () => {
	it("lists an active session whose process a probe reads gone", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		makeActiveDeadProcess(join(tmpRoot, "quests", a), "sess-dead");
		const dead = await planDeadSessions(state);
		expect(dead).toEqual([{ sessionId: "sess-dead", questId: a }]);
	});

	it("leaves an identity-less recency-dead session alone", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		// No identity and no log: dead only by the recency heuristic, too
		// uncertain to detach.
		makeActive(join(tmpRoot, "quests", a), "sess-quiet");
		expect(await planDeadSessions(state)).toEqual([]);
	});
});

describe("planSessionRepair", () => {
	it("keeps the owner named in the session log and detaches the rest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		makeActive(join(tmpRoot, "quests", a), "sess-x");
		makeActive(join(tmpRoot, "quests", b), "sess-x");
		writeLog("sess-x", b);

		const plan = planSessionRepair(state);
		expect(plan.conflicted).toEqual([]);
		expect(plan.resolvable).toEqual([
			{ sessionId: "sess-x", keep: b, detachFrom: [a] },
		]);
	});

	it("reports conflicted when the log names no claimant", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		makeActive(join(tmpRoot, "quests", a), "sess-y");
		makeActive(join(tmpRoot, "quests", b), "sess-y");
		writeLog("sess-y", null); // log cleared the quest

		const plan = planSessionRepair(state);
		expect(plan.resolvable).toEqual([]);
		expect(plan.conflicted).toEqual([
			{ sessionId: "sess-y", questIds: [a, b].sort() },
		]);
	});

	it("returns empty plans when no session diverges", async () => {
		const state = buildState();
		await createQuest(state, "Solo");
		const plan = planSessionRepair(state);
		expect(plan.resolvable).toEqual([]);
		expect(plan.conflicted).toEqual([]);
	});
});
