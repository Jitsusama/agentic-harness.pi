/**
 * The budget a quest's model calls draw on.
 *
 * `budget` with `ref` names it in the quest's front matter: a name a
 * budget provider knows, `none` to draw on the session's default
 * whatever the quests above say, or `inherit` to take the field away
 * so the quest draws on its nearest ancestor's again. Without `ref` it
 * says what the quest draws on and which quest named it. Either works
 * on any quest, loaded or not, since the person naming budgets for a
 * project names them at the top of its tree.
 *
 * The field is the harness's own, so both parsers keep it among the
 * extras, and core's verbs write it back untouched.
 */

import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import {
	budgetInRecord,
	isBudgetName,
	NO_BUDGET,
	type QuestBudget,
} from "../../../lib/internal/quest/budget.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import type { QuestState } from "../state.ts";
import { addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** The word that takes a quest's own budget away. */
const INHERIT = "inherit";

/** Name, clear or report the budget of the quest `id` names, or the loaded one. */
export function budget(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (target.documentId) {
		return refuse(
			`${target.documentId} is a document; a budget is named on a quest, so name ${target.questId}.`,
		);
	}
	const word = params.ref?.trim();
	if (!word) return report(state, target.questId);
	if (word !== INHERIT && !isBudgetName(word)) {
		return refuse(
			`"${word}" can't be a budget's name: use letters, digits, dots, dashes and underscores, starting with a letter or digit. Pass \`none\` to draw on no budget, or \`inherit\` to take the quest's own away.`,
		);
	}
	const result = mutateQuestFrontMatter(target.questDir, (fm) =>
		withBudget(fm, word === INHERIT ? undefined : word),
	);
	if (!result.ok) return refuse(result.guidance);
	appendJourneyByPath(
		target.questDir,
		word === INHERIT
			? "Budget: no longer its own; it draws on what the quests above name."
			: word === NO_BUDGET
				? "Budget: none, so its model calls draw on the session's default."
				: `Budget: ${word}, which its model calls and those of the quests under it draw on.`,
	);
	return report(state, target.questId, true);
}

/** Front matter saying `word` as its budget, or none of its own. */
function withBudget(
	fm: QuestFrontMatter,
	word: string | undefined,
): QuestFrontMatter | undefined {
	const { budget: was, ...rest } = fm._extra ?? {};
	if (was === word) return undefined;
	const extra = word === undefined ? rest : { ...rest, budget: word };
	return { ...fm, _extra: Object.keys(extra).length > 0 ? extra : undefined };
}

function report(
	state: QuestState,
	quest: string,
	changed?: boolean,
): QuestResult {
	const drawn = budgetInRecord(state.questsRoot, quest);
	return ok(saidOf(quest, drawn), {
		budget: drawn?.name ?? null,
		...(drawn ? { from: drawn.from } : {}),
		...(changed !== undefined ? { changed } : {}),
	});
}

function saidOf(quest: string, drawn: QuestBudget | undefined): string {
	const where = (from: string) => (from === quest ? "" : `, as ${from} names`);
	const loads =
		" A session takes it up as the quest loads, and one with it loaded now takes it up at once.";
	if (!drawn) {
		return `${quest} draws on no budget: nothing above it names one, so its model calls use the session's default.${loads}`;
	}
	if (drawn.name === null) {
		return `${quest} draws on no budget${where(drawn.from)}, so its model calls use the session's default.${loads}`;
	}
	return `${quest} draws on budget ${drawn.name}${where(drawn.from)}.${loads}`;
}
