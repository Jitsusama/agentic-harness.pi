/**
 * Context Shadow Workflow extension.
 *
 * Measures what a demotion policy could reclaim from resident context on
 * every real call, and changes nothing about what is sent.
 *
 * bash is the tool this exists for: it has no size tail at all, thirty
 * thousand small results each paying rent for the rest of a
 * seven-hundred-turn session, so a ceiling on any one result cannot
 * touch it. The only lever left is deciding, per call, which already
 * resident results still earn their rent, and that decision needs real
 * running data before it is ever allowed to act. This is that data.
 *
 * Every controller in this plan runs in shadow mode before any of it
 * acts, so this extension only observes: it hooks `context`, measures
 * with `findReclaimable`, publishes what it found, and returns nothing,
 * which is what leaves the request untouched.
 */

import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	accumulate,
	findReclaimable,
	INITIAL_TOTALS,
	type ReclaimTotals,
	type ToolResultLike,
} from "../../lib/context/index.js";

type OneMessage = ContextEvent["messages"][number];

/**
 * How many of the most recent tool results, of any tool, are treated as
 * the active working set and never a candidate. Mirrors the marginal
 * cost window already used for the status line's own recency reading,
 * since both are answering the same kind of question: how much of the
 * immediate past still matters.
 */
const KEEP_RECENT = 30;

/** Published after every call this extension observes. */
export const RECLAIMABLE_READING = "context:reclaimable";

export interface ReclaimableReading {
	/** This one call. */
	readonly candidates: number;
	readonly chars: number;
	/** Running totals across the session so far, this call included. */
	readonly session: ReclaimTotals;
}

/**
 * Narrow one message down to what findReclaimable needs. Every other
 * message kind still counts toward recency (it takes a slot in the
 * kept window), it simply carries nothing a candidate could be found
 * in.
 */
function toolResultLike(message: OneMessage): ToolResultLike {
	if (message.role !== "toolResult") return { role: message.role };
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
	};
}

export default function contextShadowWorkflow(pi: ExtensionAPI) {
	let totals: ReclaimTotals = INITIAL_TOTALS;

	pi.on("session_start", async () => {
		// A resumed session's resident context is not something last
		// session's totals describe, so this starts fresh rather than
		// carrying a number forward that no longer means what it says.
		totals = INITIAL_TOTALS;
	});

	pi.on("context", async (event) => {
		const messages = event.messages.map(toolResultLike);
		const analysis = findReclaimable(messages, { keepRecent: KEEP_RECENT });
		totals = accumulate(totals, analysis);
		pi.events.emit(RECLAIMABLE_READING, {
			candidates: analysis.candidates.length,
			chars: analysis.totalChars,
			session: totals,
		} satisfies ReclaimableReading);
		// No return: the request goes out exactly as pi assembled it. This
		// extension measures a lever, it does not pull one.
	});
}
