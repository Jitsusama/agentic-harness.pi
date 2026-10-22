/**
 * The quest gates under the guard policy.
 *
 * `enforce.ts` says what each gate would refuse and which guard it
 * answers to; this decides, guard by guard, what actually happens. A
 * blocking guard refuses. A redirecting guard refuses with its remedy
 * and lets the same call through when it comes back unchanged, except
 * the untracked-tree guard, which adopts the tree: the refusal only
 * ever told the agent to do that, and one session took 56 refusals to
 * stop trying the write instead. A guard that is off lets the write
 * through and shows the person what it saw. Whatever a guard lets
 * through outside every tree is noted for the quest, and `conclude`
 * names it (outside-writes.ts).
 */

import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	guardMode,
	refusalUnder,
	reportGuard,
} from "../../lib/guardian/index.ts";
import type { QuestVerdict } from "./enforce.ts";
import { recordOutsideWrites } from "./outside-writes.ts";
import type { QuestState } from "./state.ts";
import { treeAdopt } from "./verbs/tree-ops.ts";
import { defaultWorkspaceRoot } from "./workspace.ts";

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

/** How a write outside every tree is noted, so tests can watch it. */
export type NoteOutside = (state: QuestState, paths: string[]) => void;

/** Note it in the quest's workspace. */
export const noteOutside: NoteOutside = (state, paths) => {
	recordOutsideWrites(defaultWorkspaceRoot(), state.questId, paths);
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
 *
 * The subject is the call, so an override is for that call and no
 * other. It is a thunk because most calls draw no refusal, and a write
 * carries its whole content.
 */
export function applyQuestGuards(
	state: QuestState,
	verdicts: readonly QuestVerdict[],
	adopt: Adopt = adoptTree,
	subject: () => string = () => "",
	note: NoteOutside = noteOutside,
): ToolCallEventResult | undefined {
	// Noted only once every guard has let the call through, since a
	// refused call writes nothing.
	const outside: string[] = [];
	for (const verdict of verdicts) {
		const mode = guardMode(verdict.guard);
		if (mode === "block") return { block: true, reason: verdict.reason };
		outside.push(...(verdict.outside ?? []));
		if (mode === "off") {
			if (!verdict.adopt || firstRefusal(state, verdict.adopt)) {
				reportGuard({
					guard: verdict.guard,
					kind: "waved",
					title: verdict.adopt
						? `Writing into ${verdict.adopt} without adopting it`
						: "Quest gate",
					...(verdict.reason ? { body: verdict.reason } : {}),
				});
			}
			continue;
		}
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
		const refusal = refusalUnder(
			verdict.guard,
			{ block: true, reason: verdict.reason ?? "Quest gate" },
			"Quest gate",
			subject(),
		);
		if (refusal) return refusal;
	}
	if (outside.length > 0) note(state, [...new Set(outside)]);
	return undefined;
}
