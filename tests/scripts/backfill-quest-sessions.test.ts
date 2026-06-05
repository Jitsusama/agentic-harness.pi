import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseQuestFrontMatter,
	type QuestFrontMatter,
	type QuestSession,
	serializeQuestFrontMatter,
} from "../../lib/quest/index";
import {
	applyBackfill,
	planBackfill,
	scanSessionStore,
	sessionsToAdd,
} from "../../scripts/backfill-quest-sessions";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "backfill-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeLog(
	encodedCwd: string,
	sessionId: string,
	lines: object[],
): Promise<void> {
	const sub = join(dir, encodedCwd);
	await mkdir(sub, { recursive: true });
	const body = lines.map((l) => JSON.stringify(l)).join("\n");
	await writeFile(
		join(sub, `2026-06-04T10-00-00-000Z_${sessionId}.jsonl`),
		body,
	);
}

describe("scanSessionStore", () => {
	it("ignores sessions that never loaded a quest", async () => {
		await writeLog("--c--", "plain", [
			{
				type: "session",
				version: 3,
				id: "plain",
				timestamp: "2026-06-04T10:00:00.000Z",
				cwd: "/work",
			},
			{ type: "message", timestamp: "2026-06-04T10:01:00.000Z" },
		]);
		expect(scanSessionStore(dir)).toEqual([]);
	});

	it("extracts the quest id, cwd and newest activity", async () => {
		await writeLog("--work--", "019sess", [
			{
				type: "session",
				version: 3,
				id: "019sess",
				timestamp: "2026-06-04T10:00:00.000Z",
				cwd: "/work/header",
			},
			{
				type: "custom",
				customType: "quest-workflow",
				timestamp: "2026-06-04T10:05:00.000Z",
				data: { questId: "QEST-1", cwd: "/work/data" },
			},
			{
				type: "custom",
				customType: "other-ext",
				timestamp: "2026-06-04T10:06:00.000Z",
				data: {},
			},
		]);
		const records = scanSessionStore(dir);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			sessionId: "019sess",
			questId: "QEST-1",
			cwd: "/work/data",
			started: "2026-06-04T10:06:00.000Z",
		});
	});

	it("falls back to the header cwd when the entry has none", async () => {
		await writeLog("--h--", "019h", [
			{
				type: "session",
				version: 3,
				id: "019h",
				timestamp: "2026-06-04T10:00:00.000Z",
				cwd: "/header/cwd",
			},
			{
				type: "custom",
				customType: "quest-workflow",
				timestamp: "2026-06-04T10:05:00.000Z",
				data: { questId: "QEST-2" },
			},
		]);
		expect(scanSessionStore(dir)[0].cwd).toBe("/header/cwd");
	});
});

describe("sessionsToAdd", () => {
	const existing: QuestSession[] = [{ id: "old", status: "detached" }];

	it("returns derived sessions not already present", () => {
		const derived: QuestSession[] = [
			{ id: "old", status: "active" },
			{ id: "new", status: "active" },
		];
		expect(sessionsToAdd(existing, derived)).toEqual([
			{ id: "new", status: "active" },
		]);
	});

	it("returns nothing when all derived sessions already exist", () => {
		expect(sessionsToAdd(existing, [{ id: "old", status: "active" }])).toEqual(
			[],
		);
	});
});

describe("planBackfill + applyBackfill", () => {
	async function scaffoldQuest(questId: string): Promise<string> {
		const questsRoot = join(dir, "quests");
		const questDir = join(questsRoot, questId);
		await mkdir(questDir, { recursive: true });
		const fm: QuestFrontMatter = {
			id: questId,
			kind: "quest",
			parent: null,
			status: "active",
			priority: "active",
			rank: 1,
			started: "2026-06-04",
			updated: "2026-06-04",
			aliases: [],
			sessions: [],
		};
		await writeFile(
			join(questDir, "README.md"),
			`${serializeQuestFrontMatter(fm)}\n# ${questId}\n`,
		);
		return questsRoot;
	}

	it("plans and applies missing sessions, idempotently", async () => {
		const questId = "QEST-20260604-AAA111";
		const questsRoot = await scaffoldQuest(questId);
		await writeLog("--work--", "019back", [
			{
				type: "session",
				version: 3,
				id: "019back",
				timestamp: "2026-06-04T10:00:00.000Z",
				cwd: "/work",
			},
			{
				type: "custom",
				customType: "quest-workflow",
				timestamp: "2026-06-04T10:05:00.000Z",
				data: { questId, cwd: "/work" },
			},
		]);

		const plan = planBackfill(questsRoot, dir);
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0].add.map((s) => s.id)).toEqual(["019back"]);

		applyBackfill(plan);
		const readme = readFileSync(join(questsRoot, questId, "README.md"), "utf8");
		const sessions = parseQuestFrontMatter(readme)?.frontMatter.sessions ?? [];
		expect(sessions.map((s) => s.id)).toEqual(["019back"]);
		expect(sessions[0].status).toBe("detached");

		// Idempotent: a second plan finds nothing to add.
		expect(planBackfill(questsRoot, dir).entries).toHaveLength(0);
	});
});
