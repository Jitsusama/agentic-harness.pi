/**
 * Recall's part of `/compaction-status`: whether the model can reach
 * the tool now, whether summaries told it the tool exists, and whether
 * it has ever called it on this branch. A recall that is registered but
 * never called is the case worth seeing, since nothing else shows it.
 */

import {
	compactionsOn,
	type StatusSection,
} from "../../lib/compaction/index.ts";
import { RECALL_TOOL } from "../../lib/internal/recall/session.ts";

/** Recall's section sits after the selection's. */
export const RECALL_ORDER = 30;

/** Calls to the recall tool on a branch. */
function recallCalls(branch: readonly unknown[]): number {
	let calls = 0;
	for (const entry of branch) {
		const message = (entry as { type?: unknown; message?: unknown })?.message as
			| { role?: unknown; content?: unknown }
			| undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			const b = block as { type?: unknown; name?: unknown };
			if (b?.type === "toolCall" && b.name === RECALL_TOOL) calls += 1;
		}
	}
	return calls;
}

/** Recall's section, from whether the tool is active, the note and the branch. */
export function recallSection(
	active: boolean | undefined,
	note: string,
	branch: readonly unknown[],
): StatusSection {
	const compactions = compactionsOn(branch);
	const told = compactions.filter((c) =>
		c.summary.includes(note.trim()),
	).length;
	return {
		id: "session-recall-workflow",
		title: "Recall",
		order: RECALL_ORDER,
		lines: [
			`${RECALL_TOOL}: ${
				active === undefined
					? "registered (this pi cannot say whether it is active)"
					: active
						? "active"
						: "registered but not active"
			}`,
			`summaries that mention it: ${told} of ${compactions.length}`,
			`calls on this branch: ${recallCalls(branch)}`,
		],
	};
}
