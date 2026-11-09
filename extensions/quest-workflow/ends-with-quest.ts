/**
 * A session ends itself once its quest has ended.
 *
 * Joel, 4 November: "make sure we are closing any pi processes and/or
 * kitty windows that are no longer needed". That day 19 sessions were
 * still running with their quests concluded, some since the morning,
 * each with its window open, until their orchestrator ended them by
 * hand.
 *
 * Once a minute a session reads its loaded quest's status afresh, since
 * another session may have concluded it. When the quest is concluded or
 * retired, nothing runs or waits in the session and nothing is typed in
 * its prompt, at two looks in a row, the session shuts pi down, and the
 * window it was shown in closes with it. The second look gives whoever
 * concluded it a minute to carry on there: a turn, a message or a word
 * typed starts the count again, and loading another quest ends the
 * reason. A session with no quest loaded is never ended by this.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionSlot } from "../../lib/core/session/slot.ts";
import { refreshLoadedSlice } from "./lifecycle.ts";
import type { QuestState } from "./state.ts";

/** How often a session looks at its quest. */
export const LOOK_EVERY_MS = 60_000;

/** How many looks in a row find nothing left before the session ends. */
export const ENDS_AFTER_LOOKS = 2;

/** What one look finds. */
export interface SessionLook {
	/** Whether its loaded quest is concluded or retired. */
	readonly questEnded: boolean;
	/** Whether a turn runs, a message waits or words are typed. */
	readonly busy: boolean;
}

/**
 * The count of looks: call it once a look, and it calls `end` once, at
 * the look that makes `ENDS_AFTER_LOOKS` in a row with the quest ended
 * and the session not busy. A look that can't be made counts as busy.
 */
export function endingCount(
	look: () => SessionLook | undefined,
	end: () => void,
): () => void {
	let quiet = 0;
	let ended = false;
	return () => {
		if (ended) return;
		const now = look();
		quiet = now?.questEnded && !now.busy ? quiet + 1 : 0;
		if (quiet < ENDS_AFTER_LOOKS) return;
		ended = true;
		end();
	};
}

/** What a session's quest state and context say at one look. */
export function lookAt(
	state: QuestState,
	ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages" | "hasUI" | "ui">,
): SessionLook {
	refreshLoadedSlice(state);
	const status = state.questStatus;
	const typed = ctx.hasUI ? ctx.ui.getEditorText().trim().length > 0 : false;
	return {
		questEnded:
			Boolean(state.questId) &&
			(status === "concluded" || status === "retired"),
		busy: !ctx.isIdle() || ctx.hasPendingMessages() || typed,
	};
}

/**
 * The running watch, at most one per process, kept on the process so a
 * reloaded copy of this module stops the one an older copy started.
 */
const WATCH_SLOT = "agentic-harness.quest-workflow.ends-with-quest";

function watchSlot(): { timer?: ReturnType<typeof setInterval> } {
	return sessionSlot<{ timer?: ReturnType<typeof setInterval> }>(
		WATCH_SLOT,
		undefined,
		() => ({}),
	);
}

/**
 * Watch the session `ctx` belongs to, ending it once its quest has
 * ended and nothing is left in it. Starting again replaces the watch;
 * the timer never holds pi open on its own.
 */
export function watchForQuestEnd(
	state: QuestState,
	ctx: ExtensionContext,
	everyMs: number = LOOK_EVERY_MS,
): void {
	stopWatchingForQuestEnd();
	const tick = endingCount(
		() => {
			try {
				return lookAt(state, ctx);
			} catch {
				// A context gone stale can't be looked at, so it is left be.
				return undefined;
			}
		},
		() => {
			stopWatchingForQuestEnd();
			ctx.shutdown();
		},
	);
	const timer = setInterval(tick, everyMs);
	timer.unref?.();
	watchSlot().timer = timer;
}

/** Stop the watch, as a session ends. */
export function stopWatchingForQuestEnd(): void {
	const slot = watchSlot();
	if (slot.timer) clearInterval(slot.timer);
	delete slot.timer;
}
