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
 * A quest made, or given a session, with no budget named anywhere above
 * it takes the one its providers say the session's folder draws on
 * (`budgetFromFolder`), so a project's work stops drawing on the
 * person's own key: nine work quests did so on 18 Nov, one spending
 * $251 in its first hour, until each was named by hand.
 *
 * The field is the harness's own, so both parsers keep it among the
 * extras, and core's verbs write it back untouched.
 */

import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FolderBudget, WorkBudget } from "../../../lib/budget/host.ts";
import type { WorkToBudget } from "../../../lib/budget/provider.ts";
import { appendJourneyByPath } from "../../../lib/internal/quest/documents/append-journey.ts";
import {
	budgetFoundInRecord,
	budgetInRecord,
	isBudgetName,
	NO_BUDGET,
	type QuestBudget,
} from "../../../lib/internal/quest/fields/budget.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";
import { budgetOfFolder, budgetOfWork } from "../budget.ts";
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

/**
 * The budget a quest under `above` (its parent, or the quest itself,
 * or null for a new quest at the top) should be named for work in
 * `folder`: the one the providers say the folder draws on, only when
 * nothing from `above` up names one, `none` included.
 */
export async function budgetFromFolder(
	state: QuestState,
	above: string | null,
	folder: string | undefined,
): Promise<FolderBudget | undefined> {
	if (!folder) return undefined;
	if (!unnamedFrom(state, above)) return;
	// Providers are promised an absolute path, and a call's cwd may not be.
	return budgetOfFolder(state, resolve(folder));
}

/**
 * Whether nothing from `above` up names a budget, every README on the
 * way read. One that can't be read counts as naming one, since a quest
 * named under it might be named against its word.
 */
export function unnamedFrom(state: QuestState, above: string | null): boolean {
	return (
		above === null || budgetFoundInRecord(state.questsRoot, above) === undefined
	);
}

/**
 * What naming a quest's budget came to: named, nothing to name it
 * with, or left as it stood, with why.
 */
export type Naming<T> =
	| { readonly named: T }
	| { readonly unasked: true }
	| { readonly stood: string };

/** How a naming writes. */
export interface NamingOptions {
	/** False to leave `updated` as it was, for a sweep over dormant quests. */
	readonly stampUpdated?: boolean;
	/** Aborts a judgement still under way. */
	readonly signal?: AbortSignal;
}

/**
 * Write `name` as the budget of the quest in `questDir`, only if by
 * then nothing on it or above it names one. True when written, else
 * why it was left.
 */
function nameIfUnnamed(
	state: QuestState,
	questDir: string,
	name: string,
	options: NamingOptions,
): true | string {
	let stood: string | undefined;
	const result = mutateQuestFrontMatter(
		questDir,
		(fm) => {
			// Named by someone else in between, or by hand with a word that
			// can't be a budget: theirs stands, to be read and put right.
			if (fm._extra?.budget !== undefined) {
				stood = "it was named in between";
				return undefined;
			}
			// Read again under the lock, since a quest above may have been
			// named since the ask, and its name covers this one.
			const above = fm.parent
				? budgetFoundInRecord(state.questsRoot, fm.parent)
				: undefined;
			if (above === "unread") {
				stood = "a quest above it can't be read";
				return undefined;
			}
			if (above) {
				stood = `${above.from} above it was named in between`;
				return undefined;
			}
			return withBudget(fm, name);
		},
		options.stampUpdated === false ? { stampUpdated: false } : {},
	);
	if (!result.ok) return `its README couldn't be written: ${result.guidance}`;
	return stood ?? true;
}

/**
 * The provider that named a folder's budget, as every line about it
 * says it: quoted, so its id can't add a line of its own.
 */
export function namedBy(taken: Pick<FolderBudget, "provider">): string {
	return JSON.stringify(taken.provider);
}

/** The Journey's line for a budget a quest took from its folder. */
export function takenFromFolder(taken: FolderBudget, folder: string): string {
	// The folder is quoted too, so its name can't add a line either.
	return `Budget: ${taken.name}, which ${namedBy(taken)} says work in ${JSON.stringify(resolve(folder))} draws on, since nothing above it named one.`;
}

/**
 * Name the budget quest `quest` in `questDir` takes for work in
 * `folder`, when nothing above it names one, and journal why. Answers
 * the budget named, or undefined when it named none.
 */
export async function nameBudgetFromFolder(
	state: QuestState,
	quest: string,
	questDir: string,
	folder: string | undefined,
): Promise<FolderBudget | undefined> {
	const naming = await folderNaming(state, quest, questDir, folder);
	return "named" in naming ? naming.named : undefined;
}

/** {@link nameBudgetFromFolder}, saying what it came to. */
export async function folderNaming(
	state: QuestState,
	quest: string,
	questDir: string,
	folder: string | undefined,
	options: NamingOptions = {},
): Promise<Naming<FolderBudget>> {
	const taken = await budgetFromFolder(state, quest, folder);
	if (!taken || !folder) return { unasked: true };
	const written = nameIfUnnamed(state, questDir, taken.name, options);
	if (written !== true) return { stood: written };
	appendJourneyByPath(questDir, takenFromFolder(taken, folder));
	return { named: taken };
}

/**
 * The budget the providers judge a quest under `above` (as for
 * {@link budgetFromFolder}) draws on from what its work is, only when
 * nothing from `above` up names one. Asked once no folder names one.
 */
export async function budgetFromWork(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	above: string | null,
	work: WorkToBudget,
	signal?: AbortSignal,
): Promise<WorkBudget | undefined> {
	if (!unnamedFrom(state, above)) return;
	return budgetOfWork(state, work, ctx, signal);
}

/**
 * The budget a judgement names on a quest: only a sure one, and never
 * `none`, which would stop the folder's answer for every quest under it.
 */
export function namedByJudgement(judged: WorkBudget): string | undefined {
	return judged.sure && judged.name !== NO_BUDGET ? judged.name : undefined;
}

/** The Journey's line for a judgement of a quest's work. */
export function judgedFromWork(judged: WorkBudget): string {
	const by = namedBy(judged);
	const why = judged.why ? `: ${judged.why}` : "";
	if (!judged.sure) {
		return `Budget: unsure, so none named. ${by}'s best guess from its work is ${judged.name}${why}. \`quest budget\` names one.`;
	}
	if (judged.name === NO_BUDGET) {
		return `Budget: none named, since ${by} judged its work the person's own${why}.`;
	}
	return `Budget: ${judged.name}, which ${by} judged from its work, since nothing above it or its folder named one${why}.`;
}

/** What a create's first line says of a judgement of its work. */
export function judgedClause(judged: WorkBudget): string {
	const by = namedBy(judged);
	const why = judged.why ? `: ${judged.why}` : "";
	if (!judged.sure) {
		return `, drawing on no budget, since ${by} was unsure (best guess ${judged.name}${why}; \`quest budget\` names one)`;
	}
	if (judged.name === NO_BUDGET) {
		return `, drawing on no budget, since ${by} judged it the person's own work${why}`;
	}
	return `, drawing on budget ${judged.name}, which ${by} judged from its work${why} (\`quest budget\` names another)`;
}

/** The budget a quest is born on, and how its create says so. */
export interface BornBudget {
	/** The budget it names, when it names one. */
	readonly name?: string;
	/** Its Journey's lines saying where that came from, oldest first. */
	readonly journey: readonly string[];
	/** What the create's first line ends on, "" for nothing to say. */
	readonly clause: string;
	/** What the create's details say of it. */
	readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The budget a quest being made under `above` is born on, when nothing
 * above it names one: its folder's, else a judgement's of its work,
 * named only when sure and said either way. What is above is asked
 * again after the wait, up to 20 s, so a budget named there meanwhile
 * is the one it draws on, as for a quest made after.
 */
export async function budgetAtBirth(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry" | "cwd">,
	above: string | null,
	work: WorkToBudget,
	signal?: AbortSignal,
): Promise<BornBudget> {
	const byFolder = await budgetFromFolder(state, above, ctx.cwd);
	const judgement = byFolder
		? undefined
		: await budgetFromWork(state, ctx, above, work, signal);
	const unnamed = unnamedFrom(state, above);
	const folderBudget = unnamed ? byFolder : undefined;
	if (folderBudget && ctx.cwd) {
		return {
			name: folderBudget.name,
			journey: [takenFromFolder(folderBudget, ctx.cwd)],
			clause: `, drawing on budget ${folderBudget.name}, which ${namedBy(folderBudget)} says this folder's work draws on (\`quest budget\` names another)`,
			details: { budget: folderBudget.name },
		};
	}
	const judged = unnamed ? judgement : undefined;
	if (!judged) return { journey: [], clause: "", details: {} };
	const name = namedByJudgement(judged);
	return {
		...(name ? { name } : {}),
		journey: [judgedFromWork(judged)],
		clause: judgedClause(judged),
		details: {
			...(name ? { budget: name } : {}),
			judged: {
				name: judged.name,
				sure: judged.sure,
				provider: judged.provider,
			},
		},
	};
}

/**
 * Judge which budget quest `quest` in `questDir` draws on from `work`,
 * when nothing on or above it names one, naming it only when the
 * judgement is sure, and journal what was judged either way. Says
 * whether it judged, and when it named nothing for a quest named in
 * between, or one it couldn't write, why.
 */
export async function nameBudgetFromWork(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	quest: string,
	questDir: string,
	work: WorkToBudget,
	options: NamingOptions = {},
): Promise<Naming<WorkBudget>> {
	const judged = await budgetFromWork(state, ctx, quest, work, options.signal);
	if (!judged) return { unasked: true };
	const name = namedByJudgement(judged);
	if (name !== undefined) {
		const written = nameIfUnnamed(state, questDir, name, options);
		if (written !== true) return { stood: written };
	} else {
		// Named while it was judged, or made unreadable: a line saying it
		// is unsure or the person's own would contradict what it now says.
		const now = budgetFoundInRecord(state.questsRoot, quest);
		if (now === "unread") {
			return { stood: "its budget word, or one above it, can't be read" };
		}
		if (now) return { stood: "it was named in between" };
	}
	appendJourneyByPath(questDir, judgedFromWork(judged));
	return { named: judged };
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
