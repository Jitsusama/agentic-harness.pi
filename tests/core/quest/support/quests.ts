/**
 * Quests and documents on disk for the core quest tests, written the
 * way the quest store writes them, without pi's create and load verbs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
	createQuestState,
	type QuestState,
} from "../../../../lib/core/quest/state.ts";
import { discoverQuests } from "../../../../lib/internal/quest/discovery.ts";
import { mintId } from "../../../../lib/internal/quest/id.ts";
import { atomicWriteFile } from "../../../../lib/internal/quest/io.ts";
import { scaffoldQuestReadme } from "../../../../lib/internal/quest/scaffold.ts";
import {
	type DocumentFrontMatter,
	parseDocumentFrontMatter,
	parseQuestDoc,
	type QuestFrontMatter,
	serializeDocumentFrontMatter,
} from "../../../../lib/quest/index.ts";

/** A date no write made today could stamp, to tell a stamp from none. */
export const LONG_AGO = "2026-01-01";

/**
 * A quests root in a fresh temporary folder for each test, taken away
 * after it. Answers a function giving the current test's state.
 */
export function useQuestsRoot(): () => QuestState {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "core-quest-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	return () => createQuestState({ questsRoot: join(root, "quests") });
}

/** Write a quest's README under the quests root; answers its folder. */
export function seedQuest(
	state: QuestState,
	title: string,
	overrides: Partial<QuestFrontMatter> = {},
	body = "",
): string {
	const frontMatter: QuestFrontMatter = {
		id: mintId("QEST"),
		kind: "quest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: LONG_AGO,
		updated: LONG_AGO,
		aliases: [],
		sessions: [],
		...overrides,
	};
	const dir = join(state.questsRoot, frontMatter.id);
	mkdirSync(dir, { recursive: true });
	const readme = scaffoldQuestReadme({ frontMatter, title });
	atomicWriteFile(join(dir, "README.md"), `${readme}${body}`);
	return dir;
}

/** The front matter of the quest in `questDir`, as it is on disk now. */
export function questOnDisk(questDir: string): QuestFrontMatter {
	const parsed = parseQuestDoc(
		readFileSync(join(questDir, "README.md"), "utf8"),
	);
	if (!parsed) throw new Error(`${questDir} has no README that parses`);
	return parsed.frontMatter;
}

/** Load the quest in `questDir` into state, as pi's load verb would. */
export function loadIntoState(state: QuestState, questDir: string): void {
	const fm = questOnDisk(questDir);
	const entry = discoverQuests(state.questsRoot).index.quests.get(fm.id);
	if (!entry) throw new Error(`fixture quest ${fm.id} not found`);
	state.questDir = entry.dir;
	state.questId = fm.id;
	state.questTitle = entry.doc.title ?? null;
	state.questKind = fm.kind;
	state.questStatus = fm.status;
	state.questPriority = fm.priority;
}

/** A document's folder under a quest, by its kind. */
const FOLDERS: Record<DocumentFrontMatter["kind"], string> = {
	plan: "plans",
	research: "research",
	brief: "briefs",
	report: "reports",
};

/** Write a document under the quest in `questDir`; answers its path. */
export function seedDocument(
	questDir: string,
	overrides: Partial<DocumentFrontMatter> = {},
	body = "\n# A Plan\n",
): string {
	const frontMatter: DocumentFrontMatter = {
		id: mintId("PLAN"),
		kind: "plan",
		quest: questOnDisk(questDir).id,
		stage: "think",
		updated: LONG_AGO,
		...overrides,
	};
	const dir = join(questDir, FOLDERS[frontMatter.kind]);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${frontMatter.id}.md`);
	atomicWriteFile(
		path,
		`${serializeDocumentFrontMatter(frontMatter)}\n${body}`,
	);
	return path;
}

/** The front matter of the document at `path`, as it is on disk now. */
export function documentOnDisk(path: string): DocumentFrontMatter {
	const parsed = parseDocumentFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error(`${path} has no front matter that parses`);
	return parsed.frontMatter;
}
