/**
 * The persistent context the agent carries between turns: just
 * where the loop is. It wraps core/tdd's standingReminder in pi's
 * message envelope. It deliberately does not re-issue the phase
 * discipline every turn; that reminder rides the transition
 * reply, at the moment the agent asks for it.
 *
 * The conversation is only ever appended to. Earlier reminders used
 * to be stripped from every request once the loop went idle, and put
 * back when the next one started, which changed the conversation at
 * the first reminder: the provider's prefix cache re-wrote everything
 * after it at the cache-write price, on 54 of 343 loop starts and ends
 * over a month. So a loop going idle is said instead, once, in a
 * closing message that tells the model the reminders before it no
 * longer apply.
 */

import { standingReminder } from "@jitsusama/agentic-harness.core/tdd";
import type { TddState } from "./state.ts";

/** The customType tag for the injected TDD context message. */
const CONTEXT_TYPE = "tdd-workflow-context";

/** What a loop going idle says, once, after its reminders. */
const CLOSING =
	"No TDD loop is active now. The earlier TDD loop reminders no longer apply.";

/**
 * This turn's TDD context: a reminder while a loop is active, one
 * closing message when it goes idle, and nothing otherwise.
 */
export function buildTddContext(state: TddState) {
	const reminder = standingReminder(state.loop);
	if (reminder) {
		state.reminded = true;
		return contextMessage(reminder);
	}
	if (!state.reminded) {
		return;
	}
	state.reminded = false;
	return contextMessage(CLOSING);
}

/** Whether the last TDD message in these entries is a live reminder. */
export function remindedIn(entries: readonly unknown[]): boolean {
	const last = entries.filter(isTddMessage).pop();
	return last !== undefined && last.content !== CLOSING;
}

function contextMessage(content: string) {
	return {
		message: {
			customType: CONTEXT_TYPE,
			content,
			display: false,
		},
	};
}

function isTddMessage(entry: unknown): entry is { content: unknown } {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"customType" in entry &&
		entry.customType === CONTEXT_TYPE &&
		"content" in entry
	);
}
