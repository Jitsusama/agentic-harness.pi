/**
 * `budget-sweep`: name a budget for every live quest that draws on none
 * only because nothing ever named one.
 *
 * A quest made before folders and judgements named budgets drew on the
 * person's own key whatever its work was, and a create names one only
 * for the quests made after it. The sweep goes over every quest not
 * concluded or retired that has nothing on it or above it naming a
 * budget, `none` included, and asks what a create asks: the folder its
 * newest session ran in, then a judgement of its work. A sure judgement
 * names the budget; a sure personal one and an unsure one name nothing
 * and are journaled, as a create journals them. With `dryRun` it says
 * what it would name and writes nothing.
 */

import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FolderBudget, WorkBudget } from "../../../lib/budget/host.ts";
import type { WorkToBudget } from "../../../lib/budget/provider.ts";
import {
	discoverQuests,
	type QuestEntry,
} from "../../../lib/internal/quest/discovery/discovery.ts";
import { extractSection } from "../../../lib/internal/quest/documents/quest-doc.ts";
import { budgetInRecord } from "../../../lib/internal/quest/fields/budget.ts";
import type { QuestState } from "../state.ts";
import {
	budgetFromFolder,
	budgetFromWork,
	namedBy,
	namedByJudgement,
	nameBudgetFromFolder,
	nameBudgetFromWork,
} from "./budget.ts";
import { ok, type QuestResult, type QuestToolParams } from "./shared.ts";

/** How many quests are judged at once: four kept Jev near 6 s a call. */
const AT_ONCE = 4;

/** The most of a summary a judgement is handed. */
const LONGEST_SUMMARY = 1500;

/** The most names a judgement is handed. */
const MOST_NAMES = 12;

/** Statuses a quest is no longer worked on in. */
const SEALED: ReadonlySet<string> = new Set(["concluded", "retired"]);

/** What the sweep found for one quest. */
type Swept =
	| { readonly id: string; readonly folder: FolderBudget }
	| { readonly id: string; readonly judged: WorkBudget }
	| { readonly id: string; readonly unjudged: true };

/** Sweep the live quests that draw on no budget for want of a name. */
export async function budgetSweep(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	params: QuestToolParams,
): Promise<QuestResult> {
	const dry = params.dryRun === true;
	const { index } = discoverQuests(state.questsRoot);
	const unnamed = [...index.quests.entries()].filter(
		([id, entry]) =>
			!SEALED.has(entry.doc.frontMatter.status) &&
			budgetInRecord(state.questsRoot, id) === undefined,
	);
	const swept = await inTurn(unnamed, AT_ONCE, ([id, entry]) =>
		sweepOne(state, ctx, id, entry, dry),
	);
	return ok(said(swept, dry), {
		dryRun: dry,
		swept: swept.length,
		named: swept.flatMap((one) => {
			const name = nameOf(one);
			return name ? [{ id: one.id, budget: name }] : [];
		}),
		unsure: swept.flatMap((one) =>
			"judged" in one && !one.judged.sure
				? [{ id: one.id, guess: one.judged.name }]
				: [],
		),
	});
}

async function sweepOne(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	id: string,
	entry: QuestEntry,
	dry: boolean,
): Promise<Swept> {
	const folder = folderOf(entry);
	const taken = dry
		? await budgetFromFolder(state, id, folder)
		: await nameBudgetFromFolder(state, id, entry.dir, folder);
	if (taken) return { id, folder: taken };
	const work = workOf(entry, folder);
	const judged = dry
		? await budgetFromWork(state, ctx, id, work)
		: await nameBudgetFromWork(state, ctx, id, entry.dir, work);
	return judged ? { id, judged } : { id, unjudged: true };
}

/** The folder a quest's work happened in: its newest session's, else a tree's. */
function folderOf(entry: QuestEntry): string | undefined {
	const { sessions, trees } = entry.doc.frontMatter;
	const newest = [...sessions]
		.filter((session) => session.cwd)
		.sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""))
		.at(-1)?.cwd;
	const folder = newest ?? trees?.[0]?.path;
	return folder ? resolve(folder) : undefined;
}

/** What a judgement of a quest is handed: what it says it is. */
function workOf(entry: QuestEntry, folder: string | undefined): WorkToBudget {
	const { doc } = entry;
	const summary = extractSection(doc.body, "summary")
		.join("\n")
		.trim()
		.slice(0, LONGEST_SUMMARY);
	const names = doc.frontMatter.aliases
		// A quest's own branch names only the quest.
		.filter((alias) => !alias.value.startsWith("qest-"))
		.map((alias) => `${alias.type}:${alias.value}`)
		.slice(0, MOST_NAMES);
	return {
		title: doc.title ?? doc.frontMatter.id,
		...(summary ? { summary } : {}),
		...(folder ? { folder } : {}),
		...(names.length > 0 ? { names } : {}),
	};
}

/** The budget the sweep named, or would, for one quest. */
function nameOf(one: Swept): string | undefined {
	if ("folder" in one) return one.folder.name;
	if ("judged" in one) return namedByJudgement(one.judged);
	return undefined;
}

/** The sweep's answer: what it named, judged personal, was unsure of. */
function said(swept: readonly Swept[], dry: boolean): string {
	if (swept.length === 0) {
		return "Every live quest draws on a budget named on it or above it, so there was nothing to sweep.";
	}
	const named: string[] = [];
	const personal: string[] = [];
	const unsure: string[] = [];
	let unjudged = 0;
	for (const one of swept) {
		if ("unjudged" in one) {
			unjudged++;
		} else if ("folder" in one) {
			named.push(
				`- ${one.id}: ${one.folder.name}, as ${namedBy(one.folder)} says of its folder`,
			);
		} else if (namedByJudgement(one.judged)) {
			named.push(
				`- ${one.id}: ${one.judged.name}, judged by ${namedBy(one.judged)}: ${one.judged.why}`,
			);
		} else if (one.judged.sure) {
			personal.push(one.id);
		} else {
			unsure.push(
				`- ${one.id}: best guess ${one.judged.name}: ${one.judged.why}`,
			);
		}
	}
	const verb = dry ? "Would name" : "Named";
	const lines = [
		`${dry ? "Dry run, nothing written. " : ""}Swept ${swept.length} live quests drawing on no budget: ${named.length} named, ${personal.length} judged personal, ${unsure.length} unsure, ${unjudged} unjudged.`,
	];
	if (named.length > 0) lines.push("", `${verb}:`, ...named);
	if (unsure.length > 0) {
		lines.push(
			"",
			"Unsure, so none named (`quest budget` names one):",
			...unsure,
		);
	}
	if (personal.length > 0) {
		lines.push("", `Judged personal: ${personal.join(", ")}.`);
	}
	if (unjudged > 0) {
		lines.push(
			"",
			`${unjudged} had no judgement: no provider judges work, or the session has no classifier.`,
		);
	}
	return lines.join("\n");
}

/** Map `items` through `each`, at most `width` at a time, in order. */
async function inTurn<T, R>(
	items: readonly T[],
	width: number,
	each: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const at = next++;
			results[at] = await each(items[at] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, lane),
	);
	return results;
}
