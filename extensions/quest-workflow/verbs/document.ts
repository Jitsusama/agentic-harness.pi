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
 *
 * Each takes any quest's id or any document's id, loaded or not, since
 * writing a file is no reason to move the session off its own work.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import {
	replaceSection,
	setCheckbox,
	splitAtBody,
} from "../../../lib/internal/quest/body-edits.ts";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../lib/internal/quest/io.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { refreshProgress, stampQuestUpdated } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { type Address, addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Add a dated entry to a quest's Journey: the quest `id` names, or
 * the quest owning the document it names, loaded or not; else the
 * loaded quest's. A Journey lives in the README, so a document's id
 * stands for its quest.
 */
export function journal(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const entry = params.note?.trim();
	if (!entry) return refuse("Pass the entry to add as `note`.");
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (!appendJourneyByPath(target.questDir, entry)) {
		return refuse(
			`Could not add to ${displayPath(join(target.questDir, "README.md"))}; check it exists and is readable.`,
		);
	}
	stamp(state, target);
	return ok(`Added to ${target.questId}'s Journey.`);
}

/**
 * Mark the quest written to as updated today. The loaded quest also
 * recounts its progress, which the footer shows; another quest has
 * nothing in memory to refresh.
 */
function stamp(state: QuestState, target: Address): void {
	if (target.loaded) {
		refreshProgress(state);
		stampQuestUpdated(state);
		return;
	}
	// An identity transform: the write stamps `updated` and nothing else.
	mutateQuestFrontMatter(target.questDir, (fm) => fm);
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

/**
 * Replace the body of one `##` section, or add it at the end of a
 * document other than the README, whose sections are a closed set.
 */
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
		(body, readme) => replaceSection(body, heading, text, !readme),
		{
			changed: (path, _line, added) =>
				`${added ? "Added" : "Replaced"} the ${heading} section ${added ? "at the end of" : "of"} ${path}.`,
			unchanged: (path) =>
				`The ${heading} section of ${path} already reads that way.`,
		},
	);
}

type BodyEdit = (
	body: string,
	readme: boolean,
) =>
	| {
			ok: true;
			body: string;
			changed: boolean;
			line?: string;
			added?: boolean;
	  }
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
		changed: (path: string, line?: string, added?: boolean) => string;
		unchanged: (path: string, line?: string) => string;
	},
): QuestResult {
	const target = addressOf(state, params.id, { focused: true });
	if ("refusal" in target) return refuse(target.refusal);
	const shown = displayPath(target.path);
	const readme = target.documentId === undefined;
	const outcome = withQuestLock(target.questDir, () => {
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
		const result = edit(body, readme);
		if (!result.ok || !result.changed) return result;
		atomicWriteFile(target.path, head + result.body);
		return result;
	});
	if (!outcome.ok) return refuse(outcome.reason);
	if (!outcome.changed) return ok(say.unchanged(shown, outcome.line));
	stamp(state, target);
	return ok(say.changed(shown, outcome.line, outcome.added), {
		path: target.path,
	});
}
