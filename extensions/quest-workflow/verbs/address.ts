/**
 * Where an id the agent names lives: which quest, which file, and
 * whether that quest is the one this session has loaded.
 *
 * A quest id and a document id are each unique across the store, so
 * either one says by itself which quest it belongs to. The verbs that
 * edit a document used to look only under the loaded quest, and the
 * logs show agents naming a plan of another quest, or naming a quest
 * from a session with none loaded, and being sent to load it first.
 * Loading moves the session off its own work and attaches it where it
 * does not work, so the verbs that only write a file take the id at
 * its word instead.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import type { QuestState } from "../state.ts";
import { subdirForDocumentId } from "./queries.ts";

/** A quest's README or one of its documents, found by id. */
export interface Address {
	readonly questId: string;
	readonly questDir: string;
	/** The file the id names: a document, or the quest's README. */
	readonly path: string;
	/** The id named a document rather than a quest. */
	readonly documentId?: string;
	/** Whether the quest is the one this session has loaded. */
	readonly loaded: boolean;
}

/**
 * Resolve `id` to the file it names. No id means the loaded quest:
 * its focused document when `focused` asks for it, otherwise its
 * README. `readme` is always the loaded quest's README. A refusal
 * says what was looked for.
 */
export function addressOf(
	state: QuestState,
	id: string | undefined,
	options: { readonly focused: boolean },
): Address | { readonly refusal: string } {
	const named = id?.trim();
	const readme = named?.toLowerCase() === "readme";
	if (!named || readme) {
		if (!state.questId || !state.questDir) {
			return {
				refusal:
					"No quest is loaded here, so name the quest or document as `id`.",
			};
		}
		const focused = options.focused && !readme ? state.documentPath : undefined;
		return {
			questId: state.questId,
			questDir: state.questDir,
			path: focused ?? join(state.questDir, "README.md"),
			...(focused && state.documentId ? { documentId: state.documentId } : {}),
			loaded: true,
		};
	}
	const local = inLoadedQuest(state, named);
	if (local) return local;
	const { index } = discoverQuests(state.questsRoot);
	const quest = index.quests.get(named);
	if (quest) {
		return {
			questId: named,
			questDir: quest.dir,
			path: join(quest.dir, "README.md"),
			loaded: named === state.questId,
		};
	}
	if (subdirForDocumentId(named)) {
		for (const [questId, entry] of index.quests) {
			const hit = entry.documents.find((d) => d.doc.frontMatter.id === named);
			if (!hit) continue;
			return {
				questId,
				questDir: entry.dir,
				path: hit.path,
				documentId: named,
				loaded: questId === state.questId,
			};
		}
	}
	return {
		refusal: `No quest or document has the id ${named}. \`quest locate\` finds one by alias or session too.`,
	};
}

/**
 * The loaded quest's README or document, read from disk without the
 * store walk. A document whose front matter the walk cannot parse is
 * still found here, as it always was, so a broken plan can be fixed
 * through the verbs. The path is kept inside the quest's own
 * subdirectory, so an id carrying separators never reaches the disk.
 */
function inLoadedQuest(state: QuestState, named: string): Address | undefined {
	const questId = state.questId;
	const questDir = state.questDir;
	if (!questId || !questDir) return undefined;
	if (named === questId) {
		return {
			questId,
			questDir,
			path: join(questDir, "README.md"),
			loaded: true,
		};
	}
	const subdir = subdirForDocumentId(named);
	if (!subdir) return undefined;
	const expected = resolve(questDir, subdir);
	const path = resolve(expected, `${named}.md`);
	if (dirname(path) !== expected || !existsSync(path)) return undefined;
	return { questId, questDir, path, documentId: named, loaded: true };
}
