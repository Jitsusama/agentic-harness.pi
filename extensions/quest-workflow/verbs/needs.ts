/**
 * What a quest needs of the machine its sessions run on, in mycelium's
 * `kind=value` words, such as `reach=home` or `system=macos`.
 *
 * `need-add` and `need-remove` keep the list in the quest's front
 * matter as `needs`, each word checked as the node's placement reads
 * it, so a word it would not take is refused with its reason. Either
 * works on any quest, loaded or not, since the orchestrator says what a
 * quest it does not run needs. `spawn` places a session of the quest by
 * them when it is given neither a machine nor needs of its own. A
 * subquest says its own needs, taking none from its parent.
 *
 * The list is the harness's own, so both parsers keep it among the
 * extras, and core's verbs write it back untouched.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { needFrom, needWords } from "../../../lib/mesh/placement.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import type { QuestState } from "../state.ts";
import { addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** The needs a quest says, as words, or none. */
export function needsOf(
	frontMatter: Pick<QuestFrontMatter, "_extra">,
): string[] {
	const said = frontMatter._extra?.needs;
	if (!Array.isArray(said)) return [];
	return said.filter(
		(word): word is string => typeof word === "string" && word !== "",
	);
}

/** Add the needs `ref` names to the quest `id` names, or the loaded one. */
export function needAdd(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	return changeNeeds(state, params, "add");
}

/** Take the needs `ref` names off the quest `id` names, or the loaded one. */
export function needRemove(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	return changeNeeds(state, params, "remove");
}

function changeNeeds(
	state: QuestState,
	params: QuestToolParams,
	change: "add" | "remove",
): QuestResult {
	const words = wordsOf(params.ref);
	if ("refusal" in words) return refuse(words.refusal);
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; a quest's sessions need a machine, so name ${target.questId}.`,
		);
	}
	let changed: string[] = [];
	let unchanged: string[] = [];
	const result = mutateQuestFrontMatter(target.questDir, (fm) => {
		const was = needsOf(fm);
		changed = words.words.filter((word) =>
			change === "add" ? !was.includes(word) : was.includes(word),
		);
		unchanged = words.words.filter((word) => !changed.includes(word));
		if (changed.length === 0) return undefined;
		const next =
			change === "add"
				? [...was, ...changed]
				: was.filter((word) => !changed.includes(word));
		const { needs: _was, ...rest } = fm._extra ?? {};
		const extra = next.length > 0 ? { ...rest, needs: next } : rest;
		return {
			...fm,
			_extra: Object.keys(extra).length > 0 ? extra : undefined,
		};
	});
	if (!result.ok) return refuse(result.guidance);
	const quest = target.questId;
	if (changed.length === 0) {
		return ok(
			change === "add"
				? `${quest} already needs ${unchanged.join(", ")}.`
				: `${quest} didn't need ${unchanged.join(", ")}.`,
			{ needs: needsOf(result.fm), changed: false },
		);
	}
	appendJourneyByPath(
		target.questDir,
		change === "add"
			? `Needs of a machine: ${changed.join(", ")}.`
			: `No longer needs of a machine: ${changed.join(", ")}.`,
	);
	const now = needsOf(result.fm);
	const said =
		now.length > 0
			? `${quest} needs ${now.join(", ")}; its sessions start where mycelium's node places them.`
			: `${quest} needs nothing of a machine now; its sessions start here.`;
	return ok(said, { needs: now, changed: true });
}

/** The words `ref` names, comma-separated, each read as a need. */
function wordsOf(
	ref: string | undefined,
): { readonly words: string[] } | { readonly refusal: string } {
	const tokens = (ref ?? "")
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token !== "");
	if (tokens.length === 0) {
		return {
			refusal:
				"Pass the needs in `ref` as kind=value, such as `reach=home`; separate several with commas.",
		};
	}
	const words: string[] = [];
	for (const token of tokens) {
		const read = needFrom(token);
		if (!read.ok) return { refusal: `${read.reason}.` };
		const word = needWords(read.need);
		if (!words.includes(word)) words.push(word);
	}
	return { words };
}
