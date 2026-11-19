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
 *
 * It goes from the top of each tree down, a level at a time, so a
 * subquest whose parent it names is left to draw on the parent's
 * rather than named apart, as a create under that parent would be. A
 * quest already journaled personal or unsure is left as journaled
 * rather than judged and journaled again each sweep, and a quest whose
 * own word or a parent's can't be read is left alone, since a name
 * written under it might go against what it says. Naming leaves
 * `updated` as it was: the quest's work didn't change.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FolderBudget, WorkBudget } from "../../../lib/budget/host.ts";
import type { WorkToBudget } from "../../../lib/budget/provider.ts";
import {
	discoverQuests,
	type QuestEntry,
} from "../../../lib/internal/quest/discovery/discovery.ts";
import { extractSection } from "../../../lib/internal/quest/documents/quest-doc.ts";
import {
	budgetFoundInRecord,
	NO_BUDGET,
} from "../../../lib/internal/quest/fields/budget.ts";
import type { QuestState } from "../state.ts";
import {
	budgetFromFolder,
	budgetFromWork,
	folderNaming,
	type Naming,
	nameBudgetFromWork,
	namedBy,
	namedByJudgement,
} from "./budget.ts";
import { ok, type QuestResult, type QuestToolParams } from "./shared.ts";

/** How many quests are judged at once: four kept Jev near 6 s a call. */
const AT_ONCE = 4;

/** The most of a summary a judgement is handed. */
const LONGEST_SUMMARY = 1500;

/** The most names a judgement is handed. */
const MOST_NAMES = 12;

/** How far up a quest's parents its depth is counted, against a loop. */
const DEEPEST = 8;

/** Statuses a quest is no longer worked on in. */
const SEALED: ReadonlySet<string> = new Set(["concluded", "retired"]);

/**
 * A Journey entry saying a judgement named nothing (verbs/budget.ts's
 * judgedFromWork), so a sweep can tell a quest already judged. Only an
 * entry that opens so counts: one quoting it, or a seeded summary that
 * says it, is no judgement.
 */
const JUDGED_BEFORE =
	/^- \*\*\d{4}-\d{2}-\d{2}\*\*: Budget: (?:unsure, so none named\.|none named, since)/m;

/** What the sweep found for one quest. */
type Swept =
	| { readonly id: string; readonly folder: FolderBudget }
	| { readonly id: string; readonly judged: WorkBudget }
	| { readonly id: string; readonly unjudged: true }
	| { readonly id: string; readonly covered: string }
	| { readonly id: string; readonly stood: string }
	| { readonly id: string; readonly stopped: true };

/** Sweep the live quests that draw on no budget for want of a name. */
export async function budgetSweep(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	params: QuestToolParams,
	signal?: AbortSignal,
): Promise<QuestResult> {
	const dry = params.dryRun === true;
	const { index } = discoverQuests(state.questsRoot);
	const unnamed: [string, QuestEntry][] = [];
	const unread: string[] = [];
	const judgedBefore: string[] = [];
	for (const [id, entry] of index.quests) {
		if (SEALED.has(entry.doc.frontMatter.status)) continue;
		const found = budgetFoundInRecord(state.questsRoot, id);
		if (found === "unread") unread.push(id);
		else if (found !== undefined) continue;
		else if (journaledJudged(entry)) judgedBefore.push(id);
		else unnamed.push([id, entry]);
	}
	const parentOf = (id: string) =>
		index.quests.get(id)?.doc.frontMatter.parent ?? null;
	// What this run named, or in a dry run would, so a dry run says what
	// a real one would leave to a parent.
	const naming = new Set<string>();
	const swept: Swept[] = [];
	for (const level of byDepth(unnamed, parentOf)) {
		const results = await inTurn(
			level,
			AT_ONCE,
			async ([id, entry]): Promise<Swept> => {
				const coveredBy = coverOf(state, id, parentOf, naming, dry);
				if (coveredBy) return coveredBy;
				let one: Swept;
				try {
					one = await sweepOne(state, ctx, id, entry, dry, signal);
				} catch (error) {
					// One quest's lock or write failing is that quest's, said as
					// such, so the sweep still ends and says what it did.
					const why = error instanceof Error ? error.message : String(error);
					// The budget may be written and only its Journey line lost,
					// so say what it reads as now rather than that nothing was.
					const now = budgetFoundInRecord(state.questsRoot, id);
					const reads =
						typeof now === "object" && now.from === id
							? `its budget reads ${now.name ?? NO_BUDGET} now, but a write failed: `
							: "its write failed: ";
					return { id, stood: `${reads}${why}` };
				}
				// Judged nothing because the sweep was stopped, not for want
				// of a judge.
				if ("unjudged" in one && signal?.aborted) return { id, stopped: true };
				if (nameOf(one)) naming.add(id);
				return one;
			},
			signal,
		);
		for (const [at, one] of results.entries()) {
			const [id] = level[at] as [string, QuestEntry];
			swept.push(one ?? { id, stopped: true });
		}
	}
	// Left as they stood, with why, so a caller learns of a quest whose
	// budget a failed write may have left written without its Journey line.
	const stood = swept.flatMap((one) =>
		"stood" in one ? [{ id: one.id, why: one.stood }] : [],
	);
	return ok(said(swept, dry, unread, judgedBefore), {
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
		...(unread.length > 0 ? { unread } : {}),
		...(judgedBefore.length > 0 ? { judgedBefore } : {}),
		...(stood.length > 0 ? { stood } : {}),
	});
}

/**
 * Whether a quest's Journey already says a judgement named nothing for
 * it, personal or unsure, in the README's newest entries or JOURNEY.md.
 */
function journaledJudged(entry: QuestEntry): boolean {
	let journey = extractSection(entry.doc.body, "journey").join("\n");
	try {
		journey += `\n${readFileSync(join(entry.dir, "JOURNEY.md"), "utf8")}`;
	} catch {
		// No JOURNEY.md yet: the README's own entries are all there are.
	}
	return JUDGED_BEFORE.test(journey);
}

/** `quests` grouped by how many parents each has, the top first. */
function byDepth<T extends readonly [string, unknown]>(
	quests: readonly T[],
	parentOf: (id: string) => string | null,
): T[][] {
	const levels: T[][] = [];
	for (const quest of quests) {
		let depth = 0;
		for (
			let at = parentOf(quest[0]);
			at !== null && depth < DEEPEST;
			at = parentOf(at)
		) {
			depth++;
		}
		const level = levels[depth] ?? [];
		level.push(quest);
		levels[depth] = level;
	}
	return levels.filter((level) => level !== undefined);
}

/**
 * Why quest `id` is left to what is above it, when a quest above it was
 * named this run (or in a dry run would be), or has been since the sweep
 * began; undefined when nothing above it names one yet.
 */
function coverOf(
	state: QuestState,
	id: string,
	parentOf: (id: string) => string | null,
	naming: ReadonlySet<string>,
	dry: boolean,
): Swept | undefined {
	if (dry) {
		let depth = 0;
		for (
			let at = parentOf(id);
			at !== null && depth < DEEPEST;
			at = parentOf(at), depth++
		) {
			if (naming.has(at)) return { id, covered: at };
		}
		return undefined;
	}
	const found = budgetFoundInRecord(state.questsRoot, id);
	if (found === "unread") {
		return { id, stood: "its budget word, or one above it, can't be read" };
	}
	if (found?.from === id) return { id, stood: "it was named in between" };
	return found ? { id, covered: found.from } : undefined;
}

async function sweepOne(
	state: QuestState,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	id: string,
	entry: QuestEntry,
	dry: boolean,
	signal: AbortSignal | undefined,
): Promise<Swept> {
	const folder = folderOf(entry);
	const options = { stampUpdated: false, ...(signal ? { signal } : {}) };
	if (dry) {
		const taken = await budgetFromFolder(state, id, folder);
		if (taken) return { id, folder: taken };
		const judged = await budgetFromWork(
			state,
			ctx,
			id,
			workOf(entry, folder),
			signal,
		);
		return judged ? { id, judged } : { id, unjudged: true };
	}
	const byFolder = await folderNaming(state, id, entry.dir, folder, options);
	if ("named" in byFolder) return { id, folder: byFolder.named };
	if ("stood" in byFolder) return { id, stood: byFolder.stood };
	const byWork: Naming<WorkBudget> = await nameBudgetFromWork(
		state,
		ctx,
		id,
		entry.dir,
		workOf(entry, folder),
		options,
	);
	if ("named" in byWork) return { id, judged: byWork.named };
	if ("stood" in byWork) return { id, stood: byWork.stood };
	return { id, unjudged: true };
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
function said(
	swept: readonly Swept[],
	dry: boolean,
	unread: readonly string[],
	judgedBefore: readonly string[],
): string {
	if (swept.length === 0 && unread.length === 0 && judgedBefore.length === 0) {
		return "Every live quest draws on a budget named on it or above it, so there was nothing to sweep.";
	}
	const named: string[] = [];
	const personal: string[] = [];
	const unsure: string[] = [];
	const covered: string[] = [];
	const stood: string[] = [];
	let unjudged = 0;
	let stopped = 0;
	for (const one of swept) {
		if ("unjudged" in one) {
			unjudged++;
		} else if ("stopped" in one) {
			stopped++;
		} else if ("covered" in one) {
			covered.push(`${one.id} (by ${one.covered})`);
		} else if ("stood" in one) {
			stood.push(`- ${one.id}: ${one.stood}`);
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
	const counts = [
		`${named.length} named`,
		`${personal.length} judged personal`,
		`${unsure.length} unsure`,
		`${unjudged} unjudged`,
		...(covered.length > 0 ? [`${covered.length} left to a parent`] : []),
		...(stood.length > 0 ? [`${stood.length} left as they stood`] : []),
		...(stopped > 0 ? [`${stopped} not reached`] : []),
	];
	const lines = [
		`${dry ? "Dry run, nothing written. " : ""}Swept ${swept.length} live quests drawing on no budget: ${counts.join(", ")}.`,
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
	if (covered.length > 0) {
		lines.push(
			"",
			`${dry ? "Would be left" : "Left"} to draw on a parent's: ${covered.join(", ")}.`,
		);
	}
	if (stood.length > 0) lines.push("", "Left as they stood:", ...stood);
	if (unjudged > 0) {
		lines.push(
			"",
			`${unjudged} had no judgement: no provider judges work, the session has no classifier, or the judgement failed or ran past its deadline.`,
		);
	}
	if (stopped > 0) {
		lines.push("", `${stopped} not reached: the sweep was stopped.`);
	}
	if (judgedBefore.length > 0) {
		lines.push(
			"",
			`Already journaled personal or unsure, so not judged again: ${judgedBefore.join(", ")}.`,
		);
	}
	if (unread.length > 0) {
		lines.push(
			"",
			`Its own budget word, or one above it, can't be read, so left alone: ${unread.join(", ")}.`,
		);
	}
	return lines.join("\n");
}

/**
 * Map `items` through `each`, at most `width` at a time, in order. Once
 * `signal` aborts no more are started, and those left read undefined.
 */
async function inTurn<T, R>(
	items: readonly T[],
	width: number,
	each: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<(R | undefined)[]> {
	const results: (R | undefined)[] = new Array(items.length).fill(undefined);
	let next = 0;
	const lane = async () => {
		while (next < items.length && !signal?.aborted) {
			const at = next++;
			results[at] = await each(items[at] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, lane),
	);
	return results;
}
