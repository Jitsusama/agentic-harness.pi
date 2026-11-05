/**
 * Which budget a quest's model calls draw on.
 *
 * A quest's front matter may say `budget: <name>`, and a subquest that
 * says none draws on its nearest ancestor's, so naming the top of a
 * tree covers everything under it. A quest that says `budget: none`
 * stops the walk: it and the quests under it draw on the session's
 * own default, whatever the quests above name. A quest with no budget
 * anywhere above it draws on the default too.
 *
 * This differs from `needs`, which a subquest never takes from its
 * parent: what a machine must be is a fact about one quest's work,
 * while who pays for it is usually decided once for a whole project.
 *
 * Only the name is read here. What a name means is a budget
 * provider's business (lib/budget/provider.ts); the walk never asks.
 * Like `needs`, the field is kept among the extras, since core's
 * parser does not know it and writes them back untouched.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBudgetName } from "../../budget/provider.ts";
import type { QuestFrontMatter } from "../../quest/types.ts";
import { parseQuestFrontMatter } from "./frontmatter.ts";

/** The word that says a quest draws on no budget, past its parents. */
export const NO_BUDGET = "none";

/** How far up a quest's parents are followed, against a loop. */
const MOST_PARENTS = 8;

export { isBudgetName };

/**
 * What a quest's own front matter says of its budget: a name, `none`,
 * or nothing. A value that cannot be a name reads as nothing, so a
 * hand-edited typo is inherited past rather than drawn on.
 */
export function budgetSaid(
	frontMatter: Pick<QuestFrontMatter, "_extra">,
): string | undefined {
	const said = frontMatter._extra?.budget;
	if (typeof said !== "string") return undefined;
	const word = said.trim();
	return isBudgetName(word) ? word : undefined;
}

/** The budget a quest draws on, and the quest that names it. */
export interface QuestBudget {
	/** The budget's name, or null where a quest said `none`. */
	readonly name: string | null;
	/** The quest whose front matter said it: this one or an ancestor. */
	readonly from: string;
}

/**
 * The budget a quest draws on, from its own front matter or its
 * nearest ancestor's that says one, given a way to read any quest's
 * front matter. Undefined when nothing above it says any.
 */
export function budgetOf(
	quest: string,
	read: (
		quest: string,
	) => Pick<QuestFrontMatter, "_extra" | "parent"> | undefined,
): QuestBudget | undefined {
	const seen = new Set<string>();
	let at: string | null = quest;
	while (at && !seen.has(at) && seen.size <= MOST_PARENTS) {
		seen.add(at);
		const frontMatter = read(at);
		if (!frontMatter) return undefined;
		const said = budgetSaid(frontMatter);
		if (said !== undefined) {
			return { name: said === NO_BUDGET ? null : said, from: at };
		}
		at = frontMatter.parent;
	}
	return undefined;
}

/**
 * The budget a quest draws on, read from the quest records under
 * `questsRoot`, where each quest's README sits in a folder of its id.
 */
export function budgetInRecord(
	questsRoot: string,
	quest: string,
): QuestBudget | undefined {
	return budgetOf(quest, (id) => {
		let readme: string;
		try {
			readme = readFileSync(join(questsRoot, id, "README.md"), "utf8");
		} catch {
			// No README, no quest: the walk stops there.
			return undefined;
		}
		return parseQuestFrontMatter(readme)?.frontMatter;
	});
}
