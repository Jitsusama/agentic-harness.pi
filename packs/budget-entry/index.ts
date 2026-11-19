/**
 * A subagent writes the budget it draws on into its own log.
 *
 * Loaded into every reviewer and subagent with `--extension`, never
 * auto-discovered, which is why it lives outside `extensions/`: a
 * person's session already has the quest workflow writing this entry.
 *
 * A subagent starts with `--no-extensions`, so the quest workflow that
 * writes the entry in a person's session never runs in it, while it
 * still inherits the parent's budget and key and spends on them. Spend
 * read from the logs then found no budget in those runs: in one hour,
 * 294 reviewer logs carried none, and their cost went unbilled to any
 * budget. The entry is read back from the environment the subagent
 * was started with, exactly as the quest workflow reads its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// From the module directly, not the library barrel: this runs in every
// subagent and needs nothing else.
import {
	BUDGET_ENTRY,
	type BudgetRecord,
	budgetDrawnOn,
	lastRecorded,
} from "../../lib/budget/record.ts";

/** Write the budget once a session starts, unless its log says it already. */
export default function budgetEntry(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const name = budgetDrawnOn(process.env);
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		if (lastRecorded(branch) === name) return;
		const record: BudgetRecord = { v: 1, name };
		pi.appendEntry(BUDGET_ENTRY, record);
	});
}
