/**
 * The quest gates under the guard policy.
 *
 * `enforce.ts` says what each gate would refuse and which guard it
 * answers to; this decides, guard by guard, what actually happens. A
 * blocking guard refuses. A reporting guard lets the write through and
 * says what it saw, except the untracked-tree guard, whose report mode
 * adopts the tree: the refusal only ever told the agent to do that, and
 * one session took 56 refusals to stop trying the write instead.
 */

import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { guardMode, reportGuard } from "../../lib/guardian/index.ts";
import type { QuestVerdict } from "./enforce.ts";
import type { QuestState } from "./state.ts";
import { treeAdopt } from "./verbs/tree-ops.ts";

/** How a tree is adopted, so tests can stand in for the quest store. */
export type Adopt = (
	state: QuestState,
	root: string,
) => { ok: true } | { ok: false; why: string };

/** Adopt through the quest's own tree-adopt verb. */
export const adoptTree: Adopt = (state, root) => {
	const result = treeAdopt(state, { action: "tree-adopt", cwd: root });
	return result.ok ? { ok: true } : { ok: false, why: result.guidance };
};

/**
 * The roots each quest state has already failed to adopt. A main
 * checkout is refused every time, and saying so on every write into it
 * would bury the transcript, so the refusal is said once.
 */
const declined = new WeakMap<QuestState, Set<string>>();

/** Whether this is the first refusal to adopt the root for this state. */
function firstRefusal(state: QuestState, root: string): boolean {
	const roots = declined.get(state) ?? new Set<string>();
	declined.set(state, roots);
	if (roots.has(root)) return false;
	roots.add(root);
	return true;
}

/**
 * Apply each verdict's guard mode in order and return the first
 * refusal still standing, or nothing when the call may go ahead.
 */
export function applyQuestGuards(
	state: QuestState,
	verdicts: readonly QuestVerdict[],
	adopt: Adopt = adoptTree,
): ToolCallEventResult | undefined {
	for (const verdict of verdicts) {
		const mode = guardMode(verdict.guard);
		if (mode === "block") return { block: true, reason: verdict.reason };
		if (mode === "off") continue;
		if (verdict.adopt) {
			if (declined.get(state)?.has(verdict.adopt)) continue;
			const adopted = adopt(state, verdict.adopt);
			if (adopted.ok) {
				reportGuard({
					guard: verdict.guard,
					kind: "fixed",
					title: `Adopted ${verdict.adopt}`,
					body: "The quest now tracks this tree, so writes into it flow. Adopted trees are never pruned.",
				});
			} else if (firstRefusal(state, verdict.adopt)) {
				reportGuard({
					guard: verdict.guard,
					kind: "waved",
					title: `Writing into ${verdict.adopt} without adopting it`,
					body: `${adopted.why}\n\nWrites into it go ahead untracked for the rest of this session.`,
				});
			}
			continue;
		}
		reportGuard({
			guard: verdict.guard,
			kind: "waved",
			title: "Quest gate",
			...(verdict.reason ? { body: verdict.reason } : {}),
		});
	}
	return undefined;
}
