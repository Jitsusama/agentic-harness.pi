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
// Every temp dir a test creates is tracked here and removed in
// afterEach, so a failed assertion never leaks a dir under tmpdir.
let scrap: string[];

function track(dir: string): string {
	scrap.push(dir);
	return dir;
}

beforeEach(() => {
	scrap = [];
	questDir = track(mkdtempSync(join(tmpdir(), "scratch-quest-")));
	const text = `${serializeQuestFrontMatter(frontMatter())}\n# Quest\n`;
	writeFileSync(join(questDir, "README.md"), text);
});

afterEach(() => {
	for (const dir of scrap) rmSync(dir, { recursive: true, force: true });
});

function recordedScratchDir(): string | undefined {
	const text = readFileSync(join(questDir, "README.md"), "utf8");
	return parseQuestFrontMatter(text)?.frontMatter.scratchDir;
}

function setRecordedScratchDir(value: string): void {
	const text = readFileSync(join(questDir, "README.md"), "utf8");
	const parsed = parseQuestFrontMatter(text);
	if (!parsed) throw new Error("test fixture README is unparseable");
	const fm = { ...parsed.frontMatter, scratchDir: value };
	writeFileSync(
		join(questDir, "README.md"),
		`${serializeQuestFrontMatter(fm)}\n${parsed.body}`,
	);
}

describe("ensureQuestScratchDir", () => {
	it("creates a unique dir under the OS temp dir and records it", () => {
		const dir = track(ensureQuestScratchDir(questDir, QUEST_ID, null));
		expect(existsSync(dir)).toBe(true);
		expect(realpathSync(dirname(dir))).toBe(realpathSync(tmpdir()));
		expect(dir).toContain(QUEST_ID);
		expect(recordedScratchDir()).toBe(dir);
	});

	it("reuses the recorded dir on a later call", () => {
		const first = track(ensureQuestScratchDir(questDir, QUEST_ID, null));
		const second = ensureQuestScratchDir(questDir, QUEST_ID, first);
		expect(second).toBe(first);
	});

	it("reuses a dir recorded in frontmatter even when none is passed in", () => {
		// A racing session recorded a dir; a fresh caller with a null
		// current must reuse it rather than strand a second mkdtemp.
		const first = track(ensureQuestScratchDir(questDir, QUEST_ID, null));
		const second = ensureQuestScratchDir(questDir, QUEST_ID, null);
		expect(second).toBe(first);
	});

	it("throws on an unparseable README instead of orphaning a dir", () => {
		writeFileSync(join(questDir, "README.md"), "no front matter here\n");
		expect(() => ensureQuestScratchDir(questDir, QUEST_ID, null)).toThrow();
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

	it("declines to delete a recorded path that is not a managed scratch dir", () => {
		// Simulate a stale or hand-edited scratchDir pointing at a real
		// directory that is not a managed scratch namespace.
		const precious = track(mkdtempSync(join(tmpdir(), "precious-")));
		writeFileSync(join(precious, "keep.txt"), "important");
		setRecordedScratchDir(precious);
		const reaped = reapQuestScratchDir(questDir, precious);
		expect(reaped).toBe(true);
		expect(existsSync(precious)).toBe(true);
		expect(existsSync(join(precious, "keep.txt"))).toBe(true);
		expect(recordedScratchDir()).toBeUndefined();
	});
});
