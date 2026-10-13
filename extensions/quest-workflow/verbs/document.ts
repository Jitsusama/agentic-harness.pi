/**
 * Verbs that edit the body of a quest document under the quest lock:
 * `journal`, `tick`, `untick` and `section`.
 *
 * They exist because hand edits to these files kept missing. The
 * workflow rewrites a README or plan on its own (a Journey line after
 * a stage change, the sessions list on load) between the moment an
 * edit reads the file and the moment it writes, and the edit then
 * fails on text that has moved. A verb reads and writes inside one
 * lock, and never touches the front matter.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import {
	replaceSection,
	setCheckbox,
	splitAtBody,
} from "../../../lib/internal/quest/body-edits.ts";
import { discoverQuests } from "../../../lib/internal/quest/discovery.ts";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../lib/internal/quest/io.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { refreshProgress, stampQuestUpdated } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { subdirForDocumentId } from "./queries.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Add a dated entry to a quest's Journey: the one `id` names, loaded
 * or not, else the loaded quest's.
 */
export function journal(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const entry = params.note?.trim();
	if (!entry) return refuse("Pass the entry to add as `note`.");
	const target = journalTarget(state, params.id?.trim());
	if ("refusal" in target) return target.refusal;
	if (!appendJourneyByPath(target.dir, entry)) {
		return refuse(
			`Could not add to ${displayPath(join(target.dir, "README.md"))}; check it exists and is readable.`,
		);
	}
	if (target.loaded) stampQuestUpdated(state);
	// An identity transform: the write stamps `updated` and nothing else.
	else mutateQuestFrontMatter(target.dir, (fm) => fm);
	return ok(`Added to ${target.id}'s Journey.`);
}

/** The quest a Journey entry goes to, or why there is none. */
function journalTarget(
	state: QuestState,
	id: string | undefined,
):
	| { readonly id: string; readonly dir: string; readonly loaded: boolean }
	| { readonly refusal: QuestResult } {
	if (!id || id === "readme" || id === state.questId) {
		if (!state.questDir || !state.questId) {
			return {
				refusal: refuse(
					"Load a quest before journaling, or name the quest as `id`.",
				),
			};
		}
		return { id: state.questId, dir: state.questDir, loaded: true };
	}
	const quest = discoverQuests(state.questsRoot).index.quests.get(id);
	if (!quest) {
		return {
			refusal: refuse(
				`${id} is not a quest. A Journey belongs to a quest's README, so name a quest's id.`,
			),
		};
	}
	return { id, dir: quest.dir, loaded: false };
}

/** Mark a checkbox item done (`tick`) or not done (`untick`). */
export function tick(
	state: QuestState,
	params: QuestToolParams,
	done: boolean,
): QuestResult {
	const item = params.query?.trim();
	if (!item) {
		return refuse("Pass the item as `query`: its text, or the start of it.");
	}
	return editBody(state, params, (body) => setCheckbox(body, item, done), {
		changed: (path, line) =>
			`${done ? "Ticked" : "Unticked"} in ${path}: ${line?.trim()}`,
		unchanged: (path, line) =>
			`Already ${done ? "ticked" : "unticked"} in ${path}: ${line?.trim()}`,
	});
}

/** Replace the body of one `##` section. */
export function section(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const heading = params.title?.trim();
	if (!heading) return refuse("Pass the section's heading as `title`.");
	const text = params.body;
	if (text === undefined) {
		return refuse(
			"Pass the section's new text as `body`, without its heading.",
		);
	}
	return editBody(
		state,
		params,
		(body) => replaceSection(body, heading, text),
		{
			changed: (path) => `Replaced the ${heading} section of ${path}.`,
			unchanged: (path) =>
				`The ${heading} section of ${path} already reads that way.`,
		},
	);
}

type BodyEdit = (
	body: string,
) =>
	| { ok: true; body: string; changed: boolean; line?: string }
	| { ok: false; reason: string };

/**
 * Read a document, edit its body and write it back, all under the
 * quest lock, with the front matter kept byte for byte.
 */
function editBody(
	state: QuestState,
	params: QuestToolParams,
	edit: BodyEdit,
	say: {
		changed: (path: string, line?: string) => string;
		unchanged: (path: string, line?: string) => string;
	},
): QuestResult {
	const questDir = state.questDir;
	if (!questDir) return refuse("Load a quest first.");
	const target = documentTarget(state, params.id);
	if (!target.ok) return refuse(target.reason);
	const shown = displayPath(target.path);
	const outcome = withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(target.path, "utf8");
		} catch (err) {
			return {
				ok: false as const,
				reason: `Cannot read ${shown}: ${(err as Error).message}`,
			};
		}
		const { head, body } = splitAtBody(text);
		const result = edit(body);
		if (!result.ok || !result.changed) return result;
		atomicWriteFile(target.path, head + result.body);
		return result;
	});
	if (!outcome.ok) return refuse(outcome.reason);
	if (!outcome.changed) return ok(say.unchanged(shown, outcome.line));
	refreshProgress(state);
	stampQuestUpdated(state);
	return ok(say.changed(shown, outcome.line), { path: target.path });
}

/**
 * The file a body verb edits: the document `id` names, the README
 * when it names the quest, otherwise the focused document, otherwise
 * the README.
 */
function documentTarget(
	state: QuestState,
	id: string | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
	const questDir = state.questDir ?? "";
	const readme = join(questDir, "README.md");
	const named = id?.trim();
	if (!named) return { ok: true, path: state.documentPath ?? readme };
	if (named === state.questId || named.toLowerCase() === "readme") {
		return { ok: true, path: readme };
	}
	const subdir = subdirForDocumentId(named);
	if (!subdir) {
		return {
			ok: false,
			reason: `"${named}" is neither a document id nor the loaded quest's id.`,
		};
	}
	const path = join(questDir, subdir, `${named}.md`);
	if (!existsSync(path)) {
		return {
			ok: false,
			reason: `No document ${named} in ${state.questId}; expected it at ${displayPath(path)}.`,
		};
	}
	return { ok: true, path };
}
