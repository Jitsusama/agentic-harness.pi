/**
 * Which budget a session drew on, written into its own log.
 *
 * pi's log says the provider and model of every request but not whose
 * money paid for it: a team's token and the person's own key both read
 * as the same provider. So a session writes a `budget` entry whenever
 * the budget it draws on changes, and once as it starts, and whatever
 * reads the log (spend-watch, the ledger) gives each request the budget
 * of the nearest such entry before it on its branch. With no entry, a
 * request drew on the machine's default.
 *
 * What a session draws on is read from its environment, not from what
 * its quest asked for: a budget a provider couldn't draw on leaves the
 * session on its default, and a process started under a budget
 * inherits it in {@link BUDGET_VARIABLE}, so a subagent with no quest
 * of its own records its parent's. The entry is a public contract,
 * versioned in `v`; a reader passes over a version it doesn't know.
 */

import { isRecord } from "../internal/record.ts";
import { isBudgetName } from "./provider.ts";

/** The custom entry's type in pi's session log. */
export const BUDGET_ENTRY = "budget";

/**
 * The variable naming the budget a process draws on, laid with the
 * budget's credentials and inherited by what the process starts.
 */
export const BUDGET_VARIABLE = "PI_BUDGET";

/** What a `budget` entry holds. */
export interface BudgetRecord {
	readonly v: 1;
	/** The budget drawn on, or null for the machine's default. */
	readonly name: string | null;
	/** What its provider calls it, when this session drew it. */
	readonly label?: string;
	/** The provider that answered for it, when this session drew it. */
	readonly provider?: string;
}

/**
 * The budget a process draws on, from its environment: the name in
 * {@link BUDGET_VARIABLE}, or null when it names none or a word that
 * can't be a budget's name.
 */
export function budgetDrawnOn(
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	const said = env[BUDGET_VARIABLE]?.trim();
	return said && isBudgetName(said) ? said : null;
}

/** An entry of a session's branch, as far as this module reads it. */
interface BranchEntry {
	readonly type?: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/**
 * The budget the last `budget` entry on a branch names: a name, null
 * for the default, or undefined when the branch has none.
 */
export function lastRecorded(
	branch: readonly BranchEntry[],
): string | null | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry.type !== "custom" || entry.customType !== BUDGET_ENTRY) continue;
		const name = nameIn(entry.data);
		if (name !== undefined) return name;
	}
	return undefined;
}

/** The name a record's data says, or undefined when it isn't one. */
function nameIn(data: unknown): string | null | undefined {
	if (!isRecord(data) || data.v !== 1) return undefined;
	if (data.name === null) return null;
	return typeof data.name === "string" && isBudgetName(data.name)
		? data.name
		: undefined;
}
