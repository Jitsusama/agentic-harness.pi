/**
 * Each quest's share of the machine, by its priority: the file the
 * machine reads to weight a quest's cgroup against other quests'.
 */

import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	PRIORITY_WEIGHT,
	QUEST_WEIGHTS_FILE,
	writeQuestWeights,
} from "../../../extensions/quest-workflow/weights";
import { QUEUE_FIRST_FILE } from "../../../lib/internal/priority/folder";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;
let questsRoot: string;
let jobs: string;

const pi = { setSessionName: () => {} } as unknown as Parameters<
	typeof handle
>[1];
const ctx = () =>
	({
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	}) as unknown as Parameters<typeof handle>[2];

const state = () => createQuestState({ questsRoot });

async function act(
	s: ReturnType<typeof state>,
	params: Parameters<typeof handle>[3],
) {
	const result = await handle(s, pi, ctx(), params);
	if (!result.ok) throw new Error(result.guidance);
	return result.details as { id: string; path: string };
}

const weights = () =>
	JSON.parse(readFileSync(join(jobs, QUEST_WEIGHTS_FILE), "utf8")) as Record<
		string,
		number
	>;

const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-weights-"));
	questsRoot = join(tmpRoot, "quests");
	jobs = join(tmpRoot, "jobs");
	clearRefTypes();
	registerBuiltinRefTypes();
});

afterEach(() => {
	clearRefTypes();
	envGuard.leave();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a quest put first in the queue", () => {
	const first = () =>
		JSON.parse(readFileSync(join(jobs, QUEUE_FIRST_FILE), "utf8")) as string[];

	it("is marked in its front matter and listed for the queue, loaded or not", async () => {
		const s = state();
		const lab = await act(s, { action: "create", title: "Lab" });
		const other = await act(s, { action: "create", title: "Other" });
		await act(s, { action: "load", id: other.id });

		await act(s, { action: "queue-first", id: lab.id });
		writeQuestWeights(questsRoot, jobs);

		const readme = readFileSync(join(dirname(lab.path), "README.md"), "utf8");
		expect(readme).toMatch(/^queue: first$/m);
		expect(readme).toContain("Put first in the machine's queue");
		expect(first()).toEqual([lab.id]);
		expect(s.questId).toBe(other.id);

		// A later write by another verb keeps the mark.
		await act(s, { action: "load", id: lab.id });
		await act(s, { action: "park" });
		writeQuestWeights(questsRoot, jobs);
		expect(first()).toEqual([lab.id]);

		await act(s, { action: "queue-normal", id: lab.id });
		writeQuestWeights(questsRoot, jobs);
		expect(first()).toEqual([]);
		expect(
			readFileSync(join(dirname(lab.path), "README.md"), "utf8"),
		).not.toMatch(/^queue:/m);
	});

	it("refuses without an id, since it always names whose work it moves", async () => {
		const s = state();
		const lab = await act(s, { action: "create", title: "Lab" });
		await act(s, { action: "load", id: lab.id });
		const result = await handle(s, pi, ctx(), { action: "queue-first" });
		expect(result.ok).toBe(false);
	});
});

describe("each quest's weight", () => {
	it("ranks driving over active over queued over bench over someday", () => {
		expect(PRIORITY_WEIGHT.driving).toBeGreaterThan(PRIORITY_WEIGHT.active);
		expect(PRIORITY_WEIGHT.active).toBeGreaterThan(PRIORITY_WEIGHT.queued);
		expect(PRIORITY_WEIGHT.queued).toBeGreaterThan(PRIORITY_WEIGHT.bench);
		expect(PRIORITY_WEIGHT.bench).toBeGreaterThan(PRIORITY_WEIGHT.someday);
		// cgroup v2 takes weights from 1 to 10000.
		for (const weight of Object.values(PRIORITY_WEIGHT)) {
			expect(weight).toBeGreaterThanOrEqual(1);
			expect(weight).toBeLessThanOrEqual(10_000);
		}
	});

	it("is written for every open quest, by its priority", async () => {
		const s = state();
		const a = await act(s, { action: "create", title: "A" });
		const b = await act(s, { action: "create", title: "B" });
		await act(s, { action: "load", id: b.id });
		await act(s, { action: "drive" });

		expect(writeQuestWeights(questsRoot, jobs)).toBe(true);

		expect(weights()).toEqual({
			[a.id]: PRIORITY_WEIGHT.active,
			[b.id]: PRIORITY_WEIGHT.driving,
		});
	});

	it("follows a change of priority", async () => {
		const s = state();
		const a = await act(s, { action: "create", title: "A" });
		writeQuestWeights(questsRoot, jobs);
		await act(s, { action: "load", id: a.id });
		await act(s, { action: "park" });

		writeQuestWeights(questsRoot, jobs);

		expect(weights()[a.id]).toBe(PRIORITY_WEIGHT.bench);
	});

	it("leaves out a quest that is concluded, which has no work to share", async () => {
		const s = state();
		const a = await act(s, { action: "create", title: "A" });
		const b = await act(s, { action: "create", title: "B" });
		await act(s, { action: "conclude", id: a.id });

		writeQuestWeights(questsRoot, jobs);

		expect(Object.keys(weights())).toEqual([b.id]);
	});

	it("is left alone when nothing changed, so readers aren't woken for nothing", async () => {
		await act(state(), { action: "create", title: "A" });
		writeQuestWeights(questsRoot, jobs);
		const before = statSync(join(jobs, QUEST_WEIGHTS_FILE)).mtimeMs;

		expect(writeQuestWeights(questsRoot, jobs)).toBe(false);
		expect(statSync(join(jobs, QUEST_WEIGHTS_FILE)).mtimeMs).toBe(before);
	});

	it("is replaced whole, leaving nothing half-written beside it", async () => {
		await act(state(), { action: "create", title: "A" });

		writeQuestWeights(questsRoot, jobs);

		expect(readdirSync(jobs).sort()).toEqual(
			[QUEST_WEIGHTS_FILE, QUEUE_FIRST_FILE].sort(),
		);
	});

	it("is not written where there is no quests root to read", () => {
		expect(writeQuestWeights(join(tmpRoot, "none"), jobs)).toBe(false);
		expect(existsSync(join(jobs, QUEST_WEIGHTS_FILE))).toBe(false);
	});
});
