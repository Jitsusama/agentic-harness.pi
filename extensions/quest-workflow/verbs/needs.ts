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
 *
 * Given `fence` instead, they keep the fence the quest's spawns declare
 * to the node as `fence` beside it (fence-declaration.ts), a spawn's
 * own word winning.
 */

import {
	FENCE_TESTS,
	isDeclaredFence,
} from "../../../lib/internal/fence/fence-declaration.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/documents/append-journey.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
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
	if (params.fence !== undefined) {
		if (params.ref?.trim()) {
			return refuse(
				"Name needs in `ref` or a `fence`, one at a time, so each change is journalled as itself.",
			);
		}
		return changeFence(state, params, change);
	}
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

/**
 * Set the fence the quest's spawns declare to the one `fence` names, or
 * clear it, whatever `fence` says, on a remove.
 */
function changeFence(
	state: QuestState,
	params: QuestToolParams,
	change: "add" | "remove",
): QuestResult {
	const asked = params.fence?.trim();
	if (change === "add" && !isDeclaredFence(asked)) {
		return refuse(`fence is fence or strict, not "${asked}". ${FENCE_TESTS}`);
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; a quest's sessions declare a fence, so name ${target.questId}.`,
		);
	}
	let was: unknown;
	const result = mutateQuestFrontMatter(target.questDir, (fm) => {
		was = fm._extra?.fence;
		const next = change === "add" ? asked : undefined;
		if (was === next) return undefined;
		const { fence: _was, ...rest } = fm._extra ?? {};
		const extra = next === undefined ? rest : { ...rest, fence: next };
		return {
			...fm,
			_extra: Object.keys(extra).length > 0 ? extra : undefined,
		};
	});
	if (!result.ok) return refuse(result.guidance);
	const quest = target.questId;
	const now = result.fm._extra?.fence;
	if (was === now) {
		return ok(
			now === undefined
				? `${quest} declares no fence; its spawns claim what they run unless they name one.`
				: `${quest} already declares ${String(now)}.`,
			{ fence: now ?? null, changed: false },
		);
	}
	appendJourneyByPath(
		target.questDir,
		now === undefined
			? "Declares no fence: its spawns claim what they run unless they name one."
			: `Declares ${String(now)}: its spawns tell the node so unless they name another.`,
	);
	return ok(
		now === undefined
			? `${quest} declares no fence now; its spawns claim what they run unless they name one.`
			: `${quest} declares ${String(now)}; its spawns tell the node so unless they name another.`,
		{ fence: now ?? null, changed: true },
	);
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
