import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../lib/internal/quest/frontmatter";
import {
	ensureQuestScratchDir,
	reapQuestScratchDir,
} from "../../../../lib/internal/quest/scratch";
import type { QuestFrontMatter } from "../../../../lib/quest/types";

const QUEST_ID = "QEST-20260620-ABC123";

function frontMatter(): QuestFrontMatter {
	return {
		id: QUEST_ID,
		kind: "sidequest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-06-20",
		updated: "2026-06-20",
		aliases: [],
		sessions: [],
	};
}

let questDir: string;

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "scratch-quest-"));
	const text = `${serializeQuestFrontMatter(frontMatter())}\n# Quest\n`;
	writeFileSync(join(questDir, "README.md"), text);
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

function recordedScratchDir(): string | undefined {
	const text = readFileSync(join(questDir, "README.md"), "utf8");
	return parseQuestFrontMatter(text)?.frontMatter.scratchDir;
}

describe("ensureQuestScratchDir", () => {
	it("creates a unique dir under the OS temp dir and records it", () => {
		const dir = ensureQuestScratchDir(questDir, QUEST_ID, null);
		expect(existsSync(dir)).toBe(true);
		expect(realpathSync(dirname(dir))).toBe(realpathSync(tmpdir()));
		expect(dir).toContain(QUEST_ID);
		expect(recordedScratchDir()).toBe(dir);
		rmSync(dir, { recursive: true, force: true });
	});

	it("reuses the recorded dir on a later call", () => {
		const first = ensureQuestScratchDir(questDir, QUEST_ID, null);
		const second = ensureQuestScratchDir(questDir, QUEST_ID, first);
		expect(second).toBe(first);
		rmSync(first, { recursive: true, force: true });
	});
});

describe("reapQuestScratchDir", () => {
	it("removes the dir and clears the frontmatter field", () => {
		const dir = ensureQuestScratchDir(questDir, QUEST_ID, null);
		const reaped = reapQuestScratchDir(questDir, dir);
		expect(reaped).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(recordedScratchDir()).toBeUndefined();
	});
});
