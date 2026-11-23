/**
 * Lifecycle mutations for the quest workflow, and the loaded quest's
 * own slice of state: focusing and unfocusing a document, the
 * progress the widget paints, unloading, and the Journey entry a verb
 * leaves behind.
 *
 * The rest lives beside it, a module for each reason it changes, and
 * is re-exported here so every importer keeps one door: a quest's
 * documents on disk (`documents.ts`), what the quests root holds
 * (`inventory.ts`), a quest's front-matter fields and aliases
 * (`front-matter.ts`), its rank among its siblings (`ranks.ts`) and
 * the sessions it records (`sessions.ts`). What only its own module
 * reads stays there rather than here.
 *
 * Everything here operates on a `QuestState` value and plain
 * arguments, with no dependency on an adapter's own extension API
 * or session log. The pi-only counterparts -- loading a quest
 * (which sets pi's session name), persisting/restoring the loaded
 * quest across a pi session (which reads/writes pi's own session
 * log), and pruning phantom sessions against pi's session-log
 * directory -- stay in agentic-harness.pi's own lifecycle.ts,
 * which imports the mutations here for everything else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJourneyByPath } from "../../internal/quest/documents/append-journey.ts";
import { parsedFiles } from "../../internal/quest/documents/parsed-file.ts";
import { mutateQuestFrontMatter } from "../../internal/quest/fields/mutate.ts";
import {
	checkboxProgress,
	documentFrontMatterProblem,
	parseDocumentFrontMatter,
	parseQuestDoc,
} from "../../quest/index.ts";
import type { Stage } from "./machine.ts";
import type { QuestState } from "./state.ts";

export {
	createDocument,
	sealQuestDocuments,
	writeDocumentStage,
} from "./documents.ts";
export {
	addAliasesToQuest,
	removeAliasesFromQuest,
	setLoadedKind,
	setLoadedStatus,
	setQuestFieldByDir,
	setQuestParent,
	setQuestPriorityByDir,
	setQuestStatusByDir,
} from "./front-matter.ts";
export {
	ensureQuestsRoot,
	findQuestEntry,
	inventoryWorktrees,
	listAllQuests,
} from "./inventory.ts";
export {
	type RankAction,
	reorderSiblings,
	setQuestRankByDir,
} from "./ranks.ts";
export {
	attachCurrentSession,
	attachSessionInQuestDir,
	captureSessionIdentity,
	detachSessionFromLoaded,
	detachSessionIfOwner,
	detachSessionInQuestDir,
	reconcileSessionMembership,
	renameSessionInQuestDir,
} from "./sessions.ts";

/**
 * Persist the focused document's progress (or, when no
 * document is focused, the loaded quest's) into the
 * QuestState struct so the widget can paint without
 * re-parsing the body on every keystroke.
 *
 * Uses the broad `checkboxProgress` walk so every `- [ ]`
 * / `- [x]` in the body contributes regardless of which
 * section holds it. The plan, research, brief and report
 * templates each use a different section name for their
 * work list; one counter serves them all.
 */
export function refreshProgress(state: QuestState): void {
	if (state.documentPath) {
		try {
			const read = documentProgress(state.documentPath);
			if (read) {
				state.done = read.progress.done;
				state.total = read.progress.total;
				state.currentItem = read.progress.currentItem;
				state.documentStage = read.stage as Stage;
				return;
			}
		} catch {
			// Document missing or unreadable; fall through.
		}
	}
	if (state.questDir) {
		try {
			const parsed = questDoc(join(state.questDir, "README.md"));
			if (parsed) {
				const progress = checkboxProgress(parsed.body);
				state.done = progress.done;
				state.total = progress.total;
				state.currentItem = progress.currentItem;
				return;
			}
		} catch {
			// Quest missing; fall through.
		}
	}
	state.done = 0;
	state.total = 0;
	state.currentItem = undefined;
}

/**
 * Quest READMEs and documents, parsed again only once they change:
 * both refreshes run at the end of every turn, and parsing an unchanged
 * file's YAML each time was most of what they cost.
 */
const questDoc = parsedFiles(parseQuestDoc);
const documentProgress = parsedFiles((text) => {
	const parsed = parseDocumentFrontMatter(text);
	return parsed
		? {
				progress: checkboxProgress(parsed.body),
				stage: parsed.frontMatter.stage,
			}
		: undefined;
});

/**
 * Re-read the loaded quest's README and refresh the in-memory
 * slice (title, kind, status, priority) so an edit to the quest's
 * own README shows up in the status line without a manual reload.
 * No-op when no quest is loaded or the README cannot be read.
 */
export function refreshLoadedSlice(state: QuestState): void {
	if (!state.questDir) return;
	let parsed: ReturnType<typeof parseQuestDoc>;
	try {
		parsed = questDoc(join(state.questDir, "README.md"));
	} catch {
		// README missing or unreadable; leave the slice as-is.
		return;
	}
	if (!parsed) return;
	state.questTitle = parsed.title ?? null;
	state.questKind = parsed.frontMatter.kind;
	state.questStatus = parsed.frontMatter.status;
	state.questPriority = parsed.frontMatter.priority;
	state.questVerify = parsed.frontMatter.verify ?? null;
	state.scratchDir = parsed.frontMatter.scratchDir ?? null;
}

/** Unload the currently loaded quest, or let go of one still waiting to load. */
export function unloadQuest(state: QuestState): void {
	delete state.pendingQuest;
	delete state.pendingRetryAt;
	delete state.pendingTries;
	state.questDir = null;
	state.questId = null;
	state.questTitle = null;
	state.questKind = null;
	state.questStatus = null;
	state.questPriority = null;
	state.questVerify = null;
	state.scratchDir = null;
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	state.done = 0;
	state.total = 0;
}

/** Focus a document under the loaded quest. */
export function focusDocument(
	state: QuestState,
	docPath: string,
): { ok: true } | { ok: false; guidance: string } {
	if (!state.questDir) {
		return { ok: false, guidance: "Load a quest first." };
	}
	let text: string;
	try {
		text = readFileSync(docPath, "utf8");
	} catch (err) {
		return {
			ok: false,
			guidance: `Cannot read ${docPath}: ${(err as Error).message}`,
		};
	}
	const parsed = parseDocumentFrontMatter(text);
	if (!parsed) {
		// Which field, not just that one is wrong. The answer used to be found
		// by diffing the file against a sibling document.
		return {
			ok: false,
			guidance: `Cannot focus ${docPath}: ${documentFrontMatterProblem(text) ?? "its front-matter will not parse"}.`,
		};
	}
	state.documentPath = docPath;
	state.documentId = parsed.frontMatter.id;
	state.documentKind = parsed.frontMatter.kind;
	state.documentTitle = extractTitle(parsed.body);
	state.documentStage = parsed.frontMatter.stage as Stage;
	refreshProgress(state);
	return { ok: true };
}

/** Unfocus the active document. */
export function unfocusDocument(state: QuestState): void {
	state.documentPath = null;
	state.documentId = null;
	state.documentKind = null;
	state.documentTitle = null;
	state.documentStage = "idle";
	refreshProgress(state);
}

/**
 * Append a Journey entry to the loaded quest's README; answers whether
 * it was appended. A verb's Journey line is its housekeeping, so a
 * README that can't be read leaves the verb's own answer standing, and
 * nothing is written to the console, where it would land in pi's
 * editor.
 */
export function appendJourneyEntry(state: QuestState, prose: string): boolean {
	if (!state.questDir) return false;
	if (!appendJourneyByPath(state.questDir, prose)) return false;
	stampQuestUpdated(state);
	return true;
}

/** Update the loaded quest's `updated` frontmatter to today. */
export function stampQuestUpdated(state: QuestState): void {
	if (!state.questDir) return;
	// The identity transform still stamps updated in the core, so a
	// touch is validated and locked like every other quest write.
	mutateQuestFrontMatter(state.questDir, (fm) => fm);
}

function extractTitle(body: string): string | null {
	const match = /^#\s+(.+)$/m.exec(body);
	return match?.[1]?.trim() ?? null;
}
